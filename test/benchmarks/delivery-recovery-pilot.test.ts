import {test,expect} from 'bun:test';
import {reservation,settleReservation} from '../../scripts/benchmarks/delivery-recovery-pilot';
test('reservation covers largest context/cache tier and all output',()=>{
  const cost={input:10,output:50,cacheRead:1,cacheWrite:12.5,longContext:{input:20,output:75,cacheRead:2,cacheWrite:25}};
  expect(reservation(cost,1000)).toBe(((1000+8192)*40+6144*75)/1e6);
});
test('unknown partial usage retains reservation and known spend never disappears',()=>{
  expect(settleReservation(1,0,'error')).toBe(1);
  expect(settleReservation(1,0.2,'aborted')).toBe(1);
  expect(settleReservation(1,1.2,'error')).toBe(1.2);
  expect(settleReservation(1,0.2,'stop')).toBe(0.2);
  expect(settleReservation(1,NaN,'stop')).toBe(1);
});
