export function maskName(name: string): string {
  const value = name.trim()
  if (!value) return ''
  return `${value[0]}${'*'.repeat(Math.max(1, value.length - 1))}`
}

export function maskStudentNumber(studentNumber: string): string {
  const value = studentNumber.trim()
  if (value.length <= 6) return `${value.slice(0, 2)}${'*'.repeat(Math.max(1, value.length - 2))}`
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 6)}${value.slice(-2)}`
}
