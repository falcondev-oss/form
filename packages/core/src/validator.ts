import type { ZodArray, ZodObject, ZodType } from 'zod/v4'

export function getValidatorByPath(validator: ZodType, path: string[]) {
  // console.debug('getValidatorByPath', validator, path)
  if (path.length === 0) return validator

  const [key, ...rest] = path as [string, ...string[]]

  let nextValidator: ZodType | undefined

  if ('shape' in validator) {
    // eslint-disable-next-line ts/no-unsafe-assignment
    nextValidator = (validator as ZodObject).shape[key]
  }
  if ('element' in validator) {
    nextValidator = (validator as ZodArray<ZodType>).element
  }

  if (rest.length === 0 || !nextValidator) {
    return nextValidator
  }

  return getValidatorByPath(nextValidator, rest)
}
