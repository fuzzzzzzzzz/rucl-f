export type DataMode = 'local' | 'cloud'

export function resolveDataMode(envId: string, cloudAvailable: boolean): DataMode {
  return envId.trim() && cloudAvailable ? 'cloud' : 'local'
}
