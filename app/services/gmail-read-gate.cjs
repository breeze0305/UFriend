'use strict';

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Space Gmail reads per account, leaving room under the current 6,000 units/minute quota. */
class GmailReadGate {
  constructor({intervalMs=350,now=Date.now,sleep=defaultSleep}={}) {
    if (!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>60000) throw new TypeError('Invalid Gmail read interval');
    if (typeof now!=='function'||typeof sleep!=='function') throw new TypeError('Gmail read gate requires clock and sleep functions');
    this.intervalMs=intervalMs;this.now=now;this.sleep=sleep;this.accounts=new Map();
  }

  _state(accountId) {
    if (typeof accountId!=='string'||!accountId) throw new TypeError('A Gmail account is required');
    if (!this.accounts.has(accountId)) this.accounts.set(accountId,{nextAt:0,tail:Promise.resolve()});
    return this.accounts.get(accountId);
  }

  wait(accountId) {
    const state=this._state(accountId);
    const pending=state.tail.catch(()=>{}).then(async()=>{
      // A quota response can extend nextAt while a queued request is asleep.
      for (;;) {
        const remaining=state.nextAt-this.now();
        if (remaining<=0) break;
        await this.sleep(Math.ceil(remaining));
      }
      state.nextAt=this.now()+this.intervalMs;
    });
    state.tail=pending;
    return pending;
  }

  defer(accountId,milliseconds) {
    if (!Number.isFinite(milliseconds)||milliseconds<0||milliseconds>120000) throw new TypeError('Invalid Gmail retry delay');
    const state=this._state(accountId);
    state.nextAt=Math.max(state.nextAt,this.now()+Math.ceil(milliseconds));
  }
}

module.exports={GmailReadGate};
