export const cardCategories = ['本科生', '硕士生', '博士生', '教职工'] as const

export function validateRucStudentNumber(
  value: string,
  currentYear = new Date().getFullYear(),
): { valid: boolean; message?: string } {
  if (!/^\d{10}$/.test(value)) return { valid: false, message: '请输入10位数字学号' }
  const entryYear = Number(value.slice(0, 4))
  if (entryYear < 2007 || entryYear > currentYear + 1) return { valid: false, message: '请检查学号前4位的入学年份' }
  return { valid: true }
}
