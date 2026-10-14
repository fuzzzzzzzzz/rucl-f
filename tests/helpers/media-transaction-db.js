const copy = (value) => (value === undefined ? undefined : structuredClone(value))

// Optimistic document versions, isolated writes and atomic commit/rollback.
export class MediaTransactionDatabase {
  constructor(seed = {}, root = null) {
    this.records = copy(seed)
    this.root = root || this
    this.versions = root ? new Map(root.versions) : new Map()
    this.reads = new Map()
    this.writes = new Set()
    this.transactions = 0
    this.failCommits = 0
    this.failWrites = 0
    this.missingThrows = false
  }

  collection(name) {
    const database = this
    return {
      doc(id) {
        const key = `${name}/${id}`
        return {
          async get() {
            database.reads.set(key, database.versions.get(key) || 0)
            const row = database.records[name]?.[id]
            if (!row && database.root.missingThrows) throw new Error('document.get:fail document does not exist')
            return { data: row ? { _id: id, ...copy(row) } : null }
          },
          async set({ data }) {
            if (Object.prototype.hasOwnProperty.call(data, '_id')) throw new Error('不能更新_id的值')
            if (database.root.failWrites > 0) {
              database.root.failWrites -= 1
              throw new Error('synthetic write failure with sensitive body')
            }
            const stored = copy(data)
            ;(database.records[name] ||= {})[id] = stored
            database.writes.add(key)
            if (database.root === database) database.versions.set(key, (database.versions.get(key) || 0) + 1)
          },
          async update({ data }) {
            const previous = database.records[name]?.[id]
            if (!previous) throw new Error('missing document')
            await this.set({ data: { ...previous, ...data } })
          },
          async remove() {
            delete (database.records[name] ||= {})[id]
            database.writes.add(key)
            if (database.root === database) database.versions.set(key, (database.versions.get(key) || 0) + 1)
          },
        }
      },
      where(condition) {
        let maximum = Infinity
        return {
          limit(value) {
            maximum = value
            return this
          },
          async get() {
            return {
              data: Object.entries(database.records[name] || {})
                .filter(([, row]) => Object.entries(condition).every(([field, value]) => row[field] === value))
                .slice(0, maximum)
                .map(([id, row]) => ({ _id: id, ...copy(row) })),
            }
          },
        }
      },
    }
  }

  async runTransaction(operation) {
    this.transactions += 1
    const transaction = new MediaTransactionDatabase(this.records, this)
    const result = await operation(transaction)
    if (this.failCommits > 0) {
      this.failCommits -= 1
      throw new Error('ResourceUnavailable.TransactionBusy')
    }
    for (const [key, version] of transaction.reads) {
      if ((this.versions.get(key) || 0) !== version) throw new Error('DATABASE_TRANSACTION_FAIL: Transaction is busy')
    }
    for (const key of transaction.writes) {
      const separator = key.indexOf('/')
      const name = key.slice(0, separator)
      const id = key.slice(separator + 1)
      const value = transaction.records[name]?.[id]
      if (value === undefined) delete (this.records[name] ||= {})[id]
      else (this.records[name] ||= {})[id] = copy(value)
      this.versions.set(key, (this.versions.get(key) || 0) + 1)
    }
    return result
  }
}
