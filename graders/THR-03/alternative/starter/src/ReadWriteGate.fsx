module ReadWriteGate

open System
open System.Threading

type Snapshot = { Readers: int; Writers: int; Waiters: int }

/// 替代实现：ReaderWriterLockSlim 负责互斥与写者优先，计数用独立的短锁保护。
type Gate() =
    let rw = new ReaderWriterLockSlim(LockRecursionPolicy.NoRecursion)
    let counter = obj ()
    let mutable readers = 0
    let mutable writers = 0

    member _.Snapshot() : Snapshot =
        lock counter (fun () -> { Readers = readers; Writers = writers; Waiters = rw.WaitingWriteCount })

    member _.WithRead<'T>(action: unit -> 'T) : 'T =
        rw.EnterReadLock()
        lock counter (fun () -> readers <- readers + 1)
        try
            action ()
        finally
            lock counter (fun () -> readers <- readers - 1)
            rw.ExitReadLock()

    member _.WithWrite<'T>(action: unit -> 'T) : 'T =
        rw.EnterWriteLock()
        lock counter (fun () -> writers <- writers + 1)
        try
            action ()
        finally
            lock counter (fun () -> writers <- writers - 1)
            rw.ExitWriteLock()


    /// 修改完成并释放写锁之后才通知，通知异常不持有锁。
    member this.WithWriteThen<'T, 'U>(action: unit -> 'T, notify: 'T -> 'U) : 'U =
        let value = this.WithWrite(action)
        notify value
