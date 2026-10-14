'use strict';
// Client-side pacing; it never retries a rejected provider request.
class RequestRateGate {
  constructor(limit = 8, { windowMs = 61000 } = {}) {
    this.limit = this.normalize(limit); this.windowMs = windowMs; this.timestamps = []; this.queue = []; this.timer = null;
  }
  normalize(value) { const number=Number(value);return Number.isFinite(number)?Math.max(1,Math.min(10,Math.floor(number)||1)):8; }
  configure(limit) { this.limit = this.normalize(limit); this.pump(); }
  acquire(signal, count = 1, onWait = () => {}) {
    if (!Number.isInteger(count) || count < 1 || count > this.limit) return Promise.reject(new Error('本機每分鐘請求設定低於這組請求數，請調整測試組或請求節奏。'));
    if (signal?.aborted) return Promise.reject(new Error('已停止'));
    return new Promise((resolve,reject) => {
      const entry={count,signal,resolve,reject,onWait};
      entry.abort=()=>{const index=this.queue.indexOf(entry);if(index>=0){this.queue.splice(index,1);reject(new Error('已停止'));this.pump();}};
      signal?.addEventListener('abort',entry.abort,{once:true});this.queue.push(entry);this.pump();
    });
  }
  pump() {
    clearTimeout(this.timer);this.timer=null;
    const now=Date.now();this.timestamps=this.timestamps.filter(time=>time>now-this.windowMs);
    while(this.queue.length) {
      const entry=this.queue[0];
      if(entry.signal?.aborted){this.queue.shift();entry.signal.removeEventListener('abort',entry.abort);entry.reject(new Error('已停止'));continue;}
      if(this.timestamps.length+entry.count>this.limit) {
        const needed=this.timestamps.length+entry.count-this.limit;
        const wait=Math.max(1,this.timestamps[needed-1]+this.windowMs-now);
        entry.onWait(wait);this.timer=setTimeout(()=>this.pump(),wait);return;
      }
      this.queue.shift();entry.signal?.removeEventListener('abort',entry.abort);
      this.timestamps.push(...Array(entry.count).fill(now));entry.resolve();
    }
  }
  close() {clearTimeout(this.timer);this.timer=null;for(const entry of this.queue.splice(0)){entry.signal?.removeEventListener('abort',entry.abort);entry.reject(new Error('已停止'));}}
}
module.exports={RequestRateGate};
