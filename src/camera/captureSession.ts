/** Correlate native photo events; a late event must never complete a newer request. */
export class PendingCapture<T> {
  private sequence=0;
  private pending: {id:string;resolve:(value:T)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>} | null=null;
  start(send:(id:string)=>Promise<void>,timeoutMs=90000):Promise<T> {
    if(this.pending)return Promise.reject(new Error('A photo is already being captured'));
    const id=`${Date.now()}-${++this.sequence}`;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(id,new Error('Camera capture timed out. Try again.')),timeoutMs);
      this.pending={id,resolve,reject,timer};
      Promise.resolve().then(()=>{if(this.pending?.id===id)return send(id);}).catch(error=>this.fail(id,error instanceof Error?error:new Error(String(error))));
    });
  }
  complete(id:string,value:T) {
    if(this.pending?.id!==id)return false;
    const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.resolve(value);return true;
  }
  private fail(id:string,error:Error) {
    if(this.pending?.id!==id)return;
    const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.reject(error);
  }
  cancel(){if(this.pending)this.fail(this.pending.id,new Error('Capture cancelled'));}
}

/** Keep the processing queue usable even when one photo fails. */
export class PhotoJobs {
  private tail:Promise<unknown>=Promise.resolve();
  add(job:()=>Promise<void>):Promise<void> {
    const result=this.tail.then(job);
    this.tail=result.catch(()=>{});
    return result;
  }
}
