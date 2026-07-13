const tabRoutes = ['pages/home/index', 'pages/lost/index', 'pages/found/index', 'pages/profile/index']

export function tabIndexForRoute(route: string): number {
  const normalized = route.replace(/^\//, '')
  const index = tabRoutes.indexOf(normalized)
  return index < 0 ? 0 : index
}
