import "fake-indexeddb/auto";

type SuccessRequest<T> = {
  result: T;
  error: DOMException | null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null;
};

interface LazyCursorDatabaseOptions {
  room: string;
  rowCount: number;
  rowAt: (index: number) => unknown;
}

/** Install a bounded, one-row-at-a-time IndexedDB cursor adapter for storage tests. */
export function installLazyCursorDatabase(options: LazyCursorDatabaseOptions): () => void {
  const factory = indexedDB as IDBFactory & { open: IDBFactory["open"] };
  const hadOwnOpen = Object.prototype.hasOwnProperty.call(factory, "open");
  const originalOpen = factory.open;

  const database = {
    onversionchange: null as ((event: IDBVersionChangeEvent) => unknown) | null,
    close() {},
    transaction() {
      let pendingEvents = 0;
      let completed = false;
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null as ((this: IDBTransaction, event: Event) => unknown) | null,
        onerror: null as ((this: IDBTransaction, event: Event) => unknown) | null,
        onabort: null as ((this: IDBTransaction, event: Event) => unknown) | null,
        objectStore(name: string) {
          if (name === "roomDeletions") {
            return {
              get(_key: IDBValidKey) {
                const request: SuccessRequest<undefined> = { result: undefined, error: null, onsuccess: null, onerror: null };
                schedule(() => request.onsuccess?.call(request as never, new Event("success")));
                return request;
              },
            } as unknown as IDBObjectStore;
          }
          if (name !== "messages") throw new Error(`Unexpected object store: ${name}`);
          return {
            openCursor() {
              const request: SuccessRequest<IDBCursorWithValue | null> = { result: null, error: null, onsuccess: null, onerror: null };
              schedule(() => dispatchCursor(request, 0));
              return request;
            },
          } as unknown as IDBObjectStore;
        },
      };

      function schedule(callback: () => void): void {
        pendingEvents += 1;
        queueMicrotask(() => {
          callback();
          pendingEvents -= 1;
          if (pendingEvents === 0 && !completed) {
            completed = true;
            queueMicrotask(() => transaction.oncomplete?.call(transaction as never, new Event("complete")));
          }
        });
      }

      function dispatchCursor(request: SuccessRequest<IDBCursorWithValue | null>, index: number): void {
        if (index >= options.rowCount) {
          request.result = null;
          request.onsuccess?.call(request as never, new Event("success"));
          return;
        }
        const value = options.rowAt(index) as { packet: { room: string; id: string } };
        const cursor = {
          key: [value.packet.room, value.packet.id],
          value,
          continue() {
            schedule(() => dispatchCursor(request, index + 1));
          },
        } as unknown as IDBCursorWithValue;
        request.result = cursor;
        request.onsuccess?.call(request as never, new Event("success"));
      }

      return transaction as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  factory.open = (() => {
    const request: SuccessRequest<IDBDatabase> = { result: database, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => request.onsuccess?.call(request as never, new Event("success")));
    return request as unknown as IDBOpenDBRequest;
  }) as IDBFactory["open"];

  return () => {
    if (hadOwnOpen) factory.open = originalOpen;
    else delete (factory as Partial<IDBFactory>).open;
  };
}
