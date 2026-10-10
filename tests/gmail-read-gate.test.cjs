'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {GmailReadGate}=require('../app/services/gmail-read-gate.cjs');

const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function clock() {
  let now=0;const timers=[];
  return {
    now:()=>now,
    sleep:milliseconds=>new Promise(resolve=>timers.push({at:now+milliseconds,resolve})),
    async advance(milliseconds) {
      now+=milliseconds;
      for(let i=timers.length-1;i>=0;i--)if(timers[i].at<=now)timers.splice(i,1)[0].resolve();
      await settle();
    }
  };
}

test('parallel Gmail reads are paced per account while another account can start immediately',async()=>{
  const time=clock(),gate=new GmailReadGate(time),started=[];
  const one=gate.wait('one').then(()=>started.push(['one-a',time.now()]));
  const two=gate.wait('one').then(()=>started.push(['one-b',time.now()]));
  const three=gate.wait('one').then(()=>started.push(['one-c',time.now()]));
  const other=gate.wait('other').then(()=>started.push(['other',time.now()]));
  await settle();
  assert.deepEqual(started,[['one-a',0],['other',0]]);
  await time.advance(349);assert.equal(started.length,2);
  await time.advance(1);assert.deepEqual(started[2],['one-b',350]);
  await time.advance(350);assert.deepEqual(started[3],['one-c',700]);
  await Promise.all([one,two,three,other]);
});

test('a quota delay also postpones requests already waiting and cannot be shortened',async()=>{
  const time=clock(),gate=new GmailReadGate(time),started=[];
  await gate.wait('one');
  const pending=gate.wait('one').then(()=>started.push(time.now()));
  await settle();
  gate.defer('one',1000);gate.defer('one',10);
  await time.advance(350);assert.deepEqual(started,[]);
  await time.advance(649);assert.deepEqual(started,[]);
  await time.advance(1);await pending;assert.deepEqual(started,[1000]);
});

test('a failed wait does not permanently block later reads',async()=>{
  let now=0,fail=true;
  const gate=new GmailReadGate({now:()=>now,sleep:async milliseconds=>{
    if(fail){fail=false;throw new Error('interrupted');}
    now+=milliseconds;
  }});
  await gate.wait('one');
  await assert.rejects(gate.wait('one'),/interrupted/);
  await gate.wait('one');assert.equal(now,350);
});

test('invalid pacing inputs fail before scheduling any request',()=>{
  assert.throws(()=>new GmailReadGate({intervalMs:-1}),TypeError);
  assert.throws(()=>new GmailReadGate({intervalMs:Infinity}),TypeError);
  const gate=new GmailReadGate();
  assert.throws(()=>gate.wait(''),TypeError);
  assert.throws(()=>gate.defer('one',-1),TypeError);
  assert.throws(()=>gate.defer('one',Infinity),TypeError);
});
