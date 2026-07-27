interface BusyHost {
  data: { busyKey: string }
  setData: (patch: { busyKey: string }) => void
}

export type ExclusiveResult<T> = { started: false } | { started: true; value: T }

export async function runExclusiveAction<T>(
  host: BusyHost,
  key: string,
  operation: () => Promise<T>,
): Promise<ExclusiveResult<T>> {
  if (host.data.busyKey) return { started: false }
  host.setData({ busyKey: key })
  try {
    return { started: true, value: await operation() }
  } finally {
    if (host.data.busyKey === key) host.setData({ busyKey: '' })
  }
}

export function createLatestRequestGate() {
  let currentGeneration = 0
  return {
    begin() {
      currentGeneration += 1
      return currentGeneration
    },
    isCurrent(generation: number) {
      return generation === currentGeneration
    },
    invalidate() {
      currentGeneration += 1
    },
  }
}

export function createPageLifetimeGate() {
  let generation = 0
  let active = false
  return {
    activate() {
      generation += 1
      active = true
      return generation
    },
    capture() {
      return active ? generation : 0
    },
    isActive(token: number) {
      return active && token > 0 && token === generation
    },
    deactivate() {
      generation += 1
      active = false
    },
  }
}

export async function runOptimisticUpdate<T>(
  previousValue: T,
  nextValue: T,
  apply: (value: T) => void,
  persist: (value: T) => Promise<void>,
): Promise<void> {
  apply(nextValue)
  try {
    await persist(nextValue)
  } catch (error) {
    apply(previousValue)
    throw error
  }
}
