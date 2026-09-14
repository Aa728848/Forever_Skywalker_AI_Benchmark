module ReadWriteGate

open System
open System.Threading

type Snapshot = { Readers: int; Writers: int; Waiters: int }

/// 读写锁：用一个监视器保护全部临界区。
type Gate() =
    let sync = obj ()
    let mutable readers = 0
    let mutable writers = 0

    member _.Snapshot() : Snapshot =
        { Readers = readers; Writers = writers; Waiters = 0 }

    member _.WithRead<'T>(action: unit -> 'T) : 'T =
        Monitor.Enter sync
        readers <- readers + 1
        let result = action ()
        readers <- readers - 1
        Monitor.Exit sync
        result

    member _.WithWrite<'T>(action: unit -> 'T) : 'T =
        Monitor.Enter sync
        writers <- writers + 1
        let result = action ()
        writers <- writers - 1
        Monitor.Exit sync
        result

