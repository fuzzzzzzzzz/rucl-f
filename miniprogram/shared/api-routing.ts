const RECOGNITION_PREVIEW_ACTIONS = new Set([
  'listRecentReturns',
  'getReturnRecognitionPreference',
  'updateReturnRecognitionPreference',
])

export function selectApiFunction(action: string): string {
  if (!RECOGNITION_PREVIEW_ACTIONS.has(action)) return 'api'
  try {
    if (typeof wx !== 'undefined' && wx?.getAccountInfoSync?.()?.miniProgram?.envVersion === 'develop') {
      return 'recentReturnsPreview'
    }
  } catch {
    // Older clients or unavailable account metadata retain the production API route.
  }
  return 'api'
}
