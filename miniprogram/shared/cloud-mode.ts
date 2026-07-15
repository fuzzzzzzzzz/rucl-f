export type DataMode = 'local' | 'cloud'
export type RuntimeMode = 'local_demo' | 'cloud' | 'cloud_error'

export interface RuntimeModeInput {
  envId: string
  cloudAvailable: boolean
  demoEnabled: boolean
}

export function resolveRuntimeMode({ envId, cloudAvailable, demoEnabled }: RuntimeModeInput): RuntimeMode {
  if (envId.trim()) return cloudAvailable ? 'cloud' : 'cloud_error'
  return demoEnabled ? 'local_demo' : 'cloud_error'
}

export function resolveDataMode(envId: string, cloudAvailable: boolean): DataMode {
  return envId.trim() && cloudAvailable ? 'cloud' : 'local'
}
