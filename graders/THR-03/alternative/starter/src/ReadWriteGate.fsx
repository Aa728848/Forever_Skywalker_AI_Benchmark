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
        lock counter (fun () -> { Readers = readers; Writers = writers; Waiters = 0 })

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

