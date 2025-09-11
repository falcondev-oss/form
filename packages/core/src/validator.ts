import type { ZodArray, ZodObject, ZodType, ZodUnion } from 'zod/v4'
import { isTruthy } from 'remeda'
import { z } from 'zod/v4'

export function getValidatorByPath(validator: ZodType, path: string[]): ZodType | undefined {
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
  if ('options' in validator) {
    const nextValidators = (validator as ZodUnion<ZodType[]>).options
      .map((o) => getValidatorByPath(o, [key]))
      .filter(isTruthy)
    if (nextValidators.length === 0) return
    if (nextValidators.length === 1) return nextValidators[0]
    return z.union(nextValidators)
  }

  if (rest.length === 0 || !nextValidator) {
    return nextValidator
  }

  return getValidatorByPath(nextValidator, rest)
}
