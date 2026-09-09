#!/usr/bin/env python3
"""Durable, idempotent operator for launching Kiln from coding agents."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised on Windows hosts
    fcntl = None
    import msvcrt


ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
TERMINAL_RUN_STATES = {"done", "failed"}


class OperatorError(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    atomic_bytes(path, data)


def atomic_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        path_stat = path.lstat()
        if stat.S_ISLNK(path_stat.st_mode):
            raise OperatorError(f"durable operator file must not be a symbolic link: {path}")
        if not stat.S_ISREG(path_stat.st_mode):
            raise OperatorError(f"durable operator file is not regular: {path}")
        value = json.loads(path.read_text(encoding="utf-8"))
    except OperatorError:
        raise
    except (OSError, json.JSONDecodeError) as error:
        raise OperatorError(f"cannot read durable operator metadata: {error}") from error
    if not isinstance(value, dict):
        raise OperatorError("durable operator metadata is not an object")
    return value


def validate_id(value: str) -> str:
    if not ID_RE.fullmatch(value):
        raise OperatorError("request id must be 1-64 ASCII letters, digits, underscores, or hyphens")
    return value


def default_home() -> Path:
    return Path(os.environ.get("KILN_HOME", str(Path.home() / ".kiln"))).expanduser().resolve()


def resolve_bin(value: str | None) -> str:
    candidate = value or shutil.which("kiln")
    if not candidate:
        raise OperatorError("kiln executable not found; pass --kiln-bin PATH")
    path = Path(candidate).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise OperatorError(f"kiln executable is not runnable: {path}")
    return str(path)


def paths(home: Path, request_id: str) -> tuple[Path, Path, Path]:
    root = home / "operator"
    job = root / validate_id(request_id)
    return root, job, job / "job.json"


def secure_directory(path: Path, label: str) -> None:
    try:
        path_stat = path.lstat()
    except OSError as error:
        raise OperatorError(f"cannot inspect {label}: {error}") from error
    if stat.S_ISLNK(path_stat.st_mode):
        raise OperatorError(f"{label} must not be a symbolic link: {path}")
    if not stat.S_ISDIR(path_stat.st_mode):
        raise OperatorError(f"{label} is not a directory: {path}")


def validate_metadata(job: Path, metadata: dict[str, Any], home: Path, request_id: str) -> None:
    if metadata.get("version") != 1:
        raise OperatorError("unsupported operator metadata version")
    if metadata.get("requestId") != request_id or metadata.get("runId") != f"operator-{request_id}":
        raise OperatorError("operator metadata identity mismatch")
    recorded_home = metadata.get("home")
    if not isinstance(recorded_home, str) or Path(recorded_home) != home:
        raise OperatorError("operator metadata home mismatch")
    if metadata.get("logPath") != str(job / "kiln.log"):
        raise OperatorError("operator metadata log path mismatch")
    kiln_bin = metadata.get("kilnBin")
    seed_sha = metadata.get("seedSha256")
    signature = metadata.get("signature")
    attempts = metadata.get("attempts")
    if not isinstance(kiln_bin, str) or not Path(kiln_bin).is_absolute():
        raise OperatorError("operator metadata executable is invalid")
    if not isinstance(seed_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", seed_sha):
        raise OperatorError("operator metadata seed identity is invalid")
    if not isinstance(attempts, list) or not attempts:
        raise OperatorError("operator metadata attempts are invalid")
    initial_through = attempts[0].get("through") if isinstance(attempts[0], dict) else None
    expected_signature = hashlib.sha256(f"v1\0{seed_sha}\0{initial_through}\0{kiln_bin}".encode()).hexdigest()
    if signature != expected_signature:
        raise OperatorError("operator metadata signature mismatch")
    intent_path = job / "intent.json"
    if intent_path.exists() or intent_path.is_symlink():
        if read_json(intent_path) != {
            "version": 1, "requestId": request_id, "home": str(home), "signature": signature,
        }:
            raise OperatorError("operator durable intent mismatch")
    if metadata.get("launchThrough") not in {"checkpoint", "reflect"}:
        raise OperatorError("operator metadata launch boundary is invalid")
    if metadata.get("launchThrough") != attempts[-1].get("through"):
        raise OperatorError("operator metadata launch boundary does not match its latest attempt")
    if metadata.get("state") not in {"launching", "running", "exited"}:
        raise OperatorError("operator worker state is invalid")

    seed_path = job / "seed.md"
    log_path = job / "kiln.log"
    for owned_file in (seed_path, log_path):
        try:
            owned_stat = owned_file.lstat()
        except OSError as error:
            raise OperatorError(f"operator job file is unavailable: {error}") from error
        if stat.S_ISLNK(owned_stat.st_mode) or not stat.S_ISREG(owned_stat.st_mode):
            raise OperatorError(f"operator job file must be regular and not a symbolic link: {owned_file}")
    if hashlib.sha256(seed_path.read_bytes()).hexdigest() != seed_sha:
        raise OperatorError("durable seed no longer matches operator metadata")

    for index, attempt in enumerate(attempts, start=1):
        if not isinstance(attempt, dict) or attempt.get("number") != index:
            raise OperatorError("operator attempt sequence is invalid")
        operation = attempt.get("operation")
        through = attempt.get("through")
        spec_name = attempt.get("spec")
        if operation != ("start" if index == 1 else "resume") or through not in {"checkpoint", "reflect"}:
            raise OperatorError("operator attempt operation is invalid")
        if attempt.get("state") not in {"launching", "running", "exited"}:
            raise OperatorError("operator attempt state is invalid")
        if spec_name != f"attempt-{index}.json":
            raise OperatorError("operator attempt spec identity mismatch")
        spec = read_json(job / spec_name)
        expected = ([kiln_bin, "run", "new", "--seed-file", str(seed_path), "--id", f"operator-{request_id}",
                     "--through", through, "--autonomous", "--yes", "--home", str(home)]
                    if operation == "start" else
                    [kiln_bin, "run", "resume", f"operator-{request_id}", "--through", through,
                     "--autonomous", "--yes", "--home", str(home)])
        if spec.get("version") != 1 or spec.get("argv") != expected:
            raise OperatorError("operator worker command does not match durable request identity")


@contextmanager
def control_lock(job: Path, wait: bool = False):
    lock_path = job / ".control.lock"
    try:
        existing = lock_path.lstat()
        if stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode):
            raise OperatorError("operator control lock must be a regular file, not a symbolic link")
    except FileNotFoundError:
        pass
    flags = os.O_RDWR | os.O_CREAT
    flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    acquired = False
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OperatorError("operator control lock must be a regular file")
        if fcntl is None and os.fstat(descriptor).st_size == 0:  # pragma: no cover - Windows
            os.write(descriptor, b"\0")
            os.fsync(descriptor)
        deadline = time.monotonic() + 1.0 if wait else None
        while True:
            try:
                if fcntl is not None:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:  # pragma: no cover - Windows
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                acquired = True
                break
            except (BlockingIOError, OSError) as error:
                if deadline is None or time.monotonic() >= deadline:
                    raise OperatorError("another control operation is already in progress") from error
                time.sleep(0.02)
        yield
    finally:
        if acquired and fcntl is None:  # pragma: no cover - Windows
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def wait_for_metadata(path: Path) -> dict[str, Any]:
    for _ in range(50):
        if path.exists():
            return read_json(path)
        time.sleep(0.02)
    raise OperatorError("another start is creating this request; retry status shortly")


def pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def launch_worker(job: Path, metadata: dict[str, Any], attempt: int) -> int:
    log_path = Path(metadata["logPath"])
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "_worker", "--job-dir", str(job), "--attempt", str(attempt)],
            stdin=subprocess.DEVNULL,
            stdout=log_fd,
            stderr=log_fd,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        os.close(log_fd)
    metadata["attempts"][attempt - 1]["workerPid"] = process.pid
    metadata["workerPid"] = process.pid
    metadata["updatedAt"] = now()
    atomic_json(job / "job.json", metadata)
    return process.pid


def start(args: argparse.Namespace) -> dict[str, Any]:
    if not args.confirm_spend:
        raise OperatorError("start requires --confirm-spend because Kiln may make paid provider calls")
    home = Path(args.home).expanduser().resolve() if args.home else default_home()
    kiln_bin = resolve_bin(args.kiln_bin)
    seed_source = Path(os.path.abspath(os.path.expanduser(args.seed_file)))
    try:
        seed_stat = seed_source.lstat()
    except OSError as error:
        raise OperatorError(f"cannot read seed file: {error}") from error
    if stat.S_ISLNK(seed_stat.st_mode) or not stat.S_ISREG(seed_stat.st_mode):
        raise OperatorError("seed file must be a regular file, not a symbolic link")
    seed = seed_source.read_bytes()
    seed_sha = hashlib.sha256(seed).hexdigest()
    signature = hashlib.sha256(f"v1\0{seed_sha}\0{args.through}\0{kiln_bin}".encode()).hexdigest()
    root, job, metadata_path = paths(home, args.request_id)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    secure_directory(root, "operator directory")
    os.chmod(root, 0o700)
    try:
        job.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        created = False
    if not created:
        secure_directory(job, "operator job directory")
    with control_lock(job, wait=True):
        if metadata_path.exists() or metadata_path.is_symlink():
            metadata = read_json(metadata_path)
            validate_metadata(job, metadata, home, args.request_id)
            if metadata.get("signature") != signature:
                raise OperatorError("request id already exists with a different seed or start options")
            return public_job(metadata, idempotent=True)

        intent_path = job / "intent.json"
        intent = {"version": 1, "requestId": args.request_id, "home": str(home), "signature": signature}
        if intent_path.exists() or intent_path.is_symlink():
            if read_json(intent_path) != intent:
                raise OperatorError("request id has an incomplete start with different inputs")
        else:
            atomic_json(intent_path, intent)

        durable_seed = job / "seed.md"
        if durable_seed.exists() or durable_seed.is_symlink():
            try:
                seed_mode = durable_seed.lstat().st_mode
            except OSError as error:
                raise OperatorError(f"cannot inspect durable seed: {error}") from error
            if stat.S_ISLNK(seed_mode) or not stat.S_ISREG(seed_mode):
                raise OperatorError("durable seed must be a regular file, not a symbolic link")
        atomic_bytes(durable_seed, seed)
        log_path = job / "kiln.log"
        if log_path.exists() or log_path.is_symlink():
            log_mode = log_path.lstat().st_mode
            if stat.S_ISLNK(log_mode) or not stat.S_ISREG(log_mode):
                raise OperatorError("operator log must be a regular file, not a symbolic link")
        else:
            log_path.touch(mode=0o600)
        run_id = f"operator-{args.request_id}"
        command = [kiln_bin, "run", "new", "--seed-file", str(durable_seed), "--id", run_id,
                   "--through", args.through, "--autonomous", "--yes", "--home", str(home)]
        spec_path = job / "attempt-1.json"
        atomic_json(spec_path, {"version": 1, "argv": command})
        timestamp = now()
        metadata = {
            "version": 1, "requestId": args.request_id, "runId": run_id,
            "signature": signature, "seedSha256": seed_sha, "kilnBin": kiln_bin,
            "home": str(home), "logPath": str(log_path), "launchThrough": args.through,
            "state": "launching", "createdAt": timestamp, "updatedAt": timestamp,
            "attempts": [{"number": 1, "operation": "start", "through": args.through,
                          "state": "launching", "createdAt": timestamp, "spec": spec_path.name}],
        }
        atomic_json(metadata_path, metadata)
        pid = launch_worker(job, metadata, 1)
        return public_job(metadata, pid=pid, idempotent=False)


def load_job(args: argparse.Namespace) -> tuple[Path, dict[str, Any]]:
    home = Path(args.home).expanduser().resolve() if args.home else default_home()
    root, job, metadata_path = paths(home, args.request_id)
    if not root.exists():
        raise OperatorError(f"unknown operator request {args.request_id}")
    secure_directory(root, "operator directory")
    try:
        secure_directory(job, "operator job directory")
    except OperatorError as error:
        if not job.exists() and not job.is_symlink():
            raise OperatorError(f"unknown operator request {args.request_id}") from error
        raise
    if not job.is_dir():
        raise OperatorError(f"unknown operator request {args.request_id}")
    metadata = read_json(metadata_path)
    validate_metadata(job, metadata, home, args.request_id)
    if args.kiln_bin:
        requested = resolve_bin(args.kiln_bin)
        if requested != metadata.get("kilnBin"):
            raise OperatorError("--kiln-bin differs from the executable recorded for this request")
    return job, metadata


def public_job(metadata: dict[str, Any], **extra: Any) -> dict[str, Any]:
    attempt = metadata.get("attempts", [{}])[-1]
    return {
        "requestId": metadata["requestId"], "runId": metadata["runId"],
        "state": metadata.get("state"), "launchThrough": metadata.get("launchThrough"),
        "pid": metadata.get("workerPid"), "childPid": attempt.get("childPid"),
        "logPath": metadata["logPath"], **extra,
    }


def kiln_status(metadata: dict[str, Any]) -> dict[str, Any]:
    command = [metadata["kilnBin"], "run", "show", metadata["runId"], "--json", "--home", metadata["home"]]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        return {"available": False, "error": f"cannot inspect saved Kiln run: {error}"[-1000:]}
    if result.returncode != 0:
        return {"available": False, "exitCode": result.returncode,
                "error": (result.stderr or result.stdout).strip()[-1000:]}
    try:
        raw = json.loads(result.stdout)
        status = raw.get("status", {})
        return {"available": True, "id": raw.get("id"), "runDir": raw.get("dir"), "phase": status.get("phase"),
                "state": status.get("state"), "outcome": status.get("outcome"),
                "usdSpent": status.get("usdSpent", raw.get("costUsd")), "cursor": status.get("cursor"),
                "chosenIdeaId": status.get("chosenIdeaId"),
                "pausedReason": status.get("pausedReason"), "wakeAt": status.get("wakeAt"),
                "updatedAt": status.get("updatedAt")}
    except (json.JSONDecodeError, AttributeError) as error:
        return {"available": False, "exitCode": 0, "error": f"invalid kiln status JSON: {error}"}


def status(args: argparse.Namespace) -> dict[str, Any]:
    _, metadata = load_job(args)
    attempt = metadata.get("attempts", [{}])[-1]
    worker_alive = metadata.get("state") in {"launching", "running"} and pid_alive(metadata.get("workerPid"))
    child_alive = attempt.get("state") == "running" and pid_alive(attempt.get("childPid"))
    process = {"workerAlive": worker_alive, "kilnAlive": child_alive,
               "workerState": metadata.get("state"), "exitCode": attempt.get("exitCode")}
    run = kiln_status(metadata)
    return {**public_job(metadata), "process": process, "run": run,
            "endpoint": endpoint_status(metadata, process, run)}


def endpoint_status(metadata: dict[str, Any], process: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    requested = metadata.get("launchThrough", "checkpoint")
    phase = run.get("phase") if run.get("available") else None
    state = run.get("state") if run.get("available") else None
    if requested == "checkpoint":
        reached = phase in {"form", "build", "reflect"}
    else:
        reached = phase == "reflect" and state in TERMINAL_RUN_STATES
    if reached and requested == "checkpoint" and state == "running" and process.get("exitCode") == 0:
        disposition = "awaiting_delivery"
    elif reached:
        disposition = "completed"
    elif process.get("workerAlive") or process.get("kilnAlive"):
        disposition = "running"
    elif process.get("exitCode") not in {None, 0}:
        disposition = "worker_failed"
    elif state in TERMINAL_RUN_STATES:
        disposition = "ended_before_boundary"
    elif not run.get("available"):
        disposition = "run_unavailable"
    else:
        disposition = "worker_exited_before_boundary"
    return {"requested": requested, "reached": reached, "disposition": disposition}


def tail_lines(path: Path, count: int, byte_limit: int = 1_048_576) -> list[str]:
    if count == 0 or not path.exists():
        return []
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        end = handle.tell()
        lower_bound = max(0, end - byte_limit)
        position = end
        chunks: list[bytes] = []
        newline_count = 0
        while position > lower_bound and newline_count <= count:
            size = min(8192, position - lower_bound)
            position -= size
            handle.seek(position)
            chunks.append(handle.read(size))
            newline_count += chunks[-1].count(b"\n")
        data = b"".join(reversed(chunks))
    return data.decode("utf-8", errors="replace").splitlines()[-count:]


def logs(args: argparse.Namespace) -> dict[str, Any]:
    _, metadata = load_job(args)
    return {"requestId": metadata["requestId"], "runId": metadata["runId"],
            "logPath": metadata["logPath"], "lines": tail_lines(Path(metadata["logPath"]), args.lines)}


def pause(args: argparse.Namespace) -> dict[str, Any]:
    job, loaded = load_job(args)
    with control_lock(job):
        metadata = read_json(job / "job.json")
        validate_metadata(job, metadata, Path(loaded["home"]), args.request_id)
        command = [metadata["kilnBin"], "build", "pause", metadata["runId"], "--json", "--home", metadata["home"]]
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=False)
        if result.returncode != 0:
            raise OperatorError((result.stderr or result.stdout).strip()[-1000:] or "kiln pause failed")
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError:
            response = {"message": result.stdout.strip()}
        return {"requestId": metadata["requestId"], "runId": metadata["runId"], "pause": response}


def resume(args: argparse.Namespace) -> dict[str, Any]:
    if not args.confirm_spend:
        raise OperatorError("resume requires --confirm-spend because Kiln may make paid provider calls")
    job, loaded = load_job(args)
    with control_lock(job):
        metadata = read_json(job / "job.json")
        validate_metadata(job, metadata, Path(loaded["home"]), args.request_id)
        attempt = metadata.get("attempts", [{}])[-1]
        if metadata.get("state") in {"launching", "running"} and (pid_alive(metadata.get("workerPid")) or pid_alive(attempt.get("childPid"))):
            raise OperatorError("the prior operator attempt is still running")
        actual = kiln_status(metadata)
        if not actual.get("available"):
            raise OperatorError("saved Kiln run is unavailable; refusing an unsafe retry")
        if actual.get("state") in TERMINAL_RUN_STATES:
            raise OperatorError(f"saved Kiln run already ended ({actual.get('state')})")
        through = args.through or metadata.get("launchThrough", "checkpoint")
        number = len(metadata["attempts"]) + 1
        spec_path = job / f"attempt-{number}.json"
        command = [metadata["kilnBin"], "run", "resume", metadata["runId"], "--through", through,
                   "--autonomous", "--yes", "--home", metadata["home"]]
        atomic_json(spec_path, {"version": 1, "argv": command})
        timestamp = now()
        metadata["launchThrough"] = through
        metadata["state"] = "launching"
        metadata["attempts"].append({"number": number, "operation": "resume", "through": through,
                                     "state": "launching", "createdAt": timestamp, "spec": spec_path.name})
        metadata["updatedAt"] = timestamp
        atomic_json(job / "job.json", metadata)
        pid = launch_worker(job, metadata, number)
        return public_job(metadata, pid=pid, resumed=True)


def worker(args: argparse.Namespace) -> int:
    job = Path(args.job_dir)
    if not job.is_absolute():
        raise OperatorError("operator worker job directory must be absolute")
    secure_directory(job, "operator job directory")
    metadata_path = job / "job.json"
    metadata = wait_for_metadata(metadata_path)
    validate_metadata(job, metadata, job.parent.parent, metadata["requestId"])
    index = args.attempt - 1
    if index < 0 or index >= len(metadata.get("attempts", [])):
        raise OperatorError("worker attempt is missing from metadata")
    for _ in range(250):
        metadata = read_json(metadata_path)
        if metadata["attempts"][index].get("workerPid") == os.getpid():
            break
        time.sleep(0.02)
    else:
        raise OperatorError("worker launch handshake timed out")
    spec = read_json(job / metadata["attempts"][index]["spec"])
    argv = spec.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(value, str) for value in argv):
        raise OperatorError("invalid durable worker command")
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, start_new_session=False, close_fds=True)
    except (OSError, subprocess.SubprocessError) as error:
        metadata = read_json(metadata_path)
        if metadata["attempts"][index].get("workerPid") == os.getpid():
            metadata["state"] = "exited"
            metadata["attempts"][index].update({"state": "exited", "finishedAt": now(), "exitCode": 127})
            metadata["updatedAt"] = now()
            atomic_json(metadata_path, metadata)
        raise OperatorError(f"cannot launch saved Kiln command: {error}") from error
    metadata = read_json(metadata_path)
    metadata["state"] = "running"
    metadata["attempts"][index].update({"state": "running", "startedAt": now(), "childPid": process.pid})
    metadata["updatedAt"] = now()
    atomic_json(metadata_path, metadata)
    exit_code = process.wait()
    metadata = read_json(metadata_path)
    metadata["state"] = "exited"
    metadata["attempts"][index].update({"state": "exited", "finishedAt": now(), "exitCode": exit_code})
    metadata["updatedAt"] = now()
    atomic_json(metadata_path, metadata)
    return exit_code


def parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--home", default=argparse.SUPPRESS, help="Kiln home (default: KILN_HOME or ~/.kiln)")
    common.add_argument("--kiln-bin", default=argparse.SUPPRESS, help="Kiln executable (default: kiln on PATH)")
    root = argparse.ArgumentParser(description="Launch and monitor durable Kiln jobs", parents=[common])
    commands = root.add_subparsers(dest="command", required=True)
    start_parser = commands.add_parser("start", parents=[common])
    start_parser.add_argument("--seed-file", required=True)
    start_parser.add_argument("--request-id", required=True)
    start_parser.add_argument("--through", choices=["checkpoint", "reflect"], default="checkpoint")
    start_parser.add_argument("--confirm-spend", action="store_true")
    for name in ("status", "pause"):
        command = commands.add_parser(name, parents=[common])
        command.add_argument("--request-id", required=True)
    logs_parser = commands.add_parser("logs", parents=[common])
    logs_parser.add_argument("--request-id", required=True)
    logs_parser.add_argument("--lines", type=int, default=40, choices=range(0, 1001), metavar="0..1000")
    resume_parser = commands.add_parser("resume", parents=[common])
    resume_parser.add_argument("--request-id", required=True)
    resume_parser.add_argument("--through", choices=["checkpoint", "reflect"])
    resume_parser.add_argument("--confirm-spend", action="store_true")
    hidden = commands.add_parser("_worker", help=argparse.SUPPRESS)
    hidden.add_argument("--job-dir", required=True)
    hidden.add_argument("--attempt", required=True, type=int)
    return root


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    args = parser().parse_args(argv)
    if not hasattr(args, "home"):
        args.home = None
    if not hasattr(args, "kiln_bin"):
        args.kiln_bin = None
    try:
        if args.command == "_worker":
            return worker(args)
        action = {"start": start, "status": status, "logs": logs, "pause": pause, "resume": resume}[args.command]
        print(json.dumps(action(args), sort_keys=True))
        return 0
    except (OperatorError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error), "ok": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
