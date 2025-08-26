/* eslint-disable ts/no-unsafe-assignment */
/* eslint-disable ts/no-unsafe-member-access */
import type {
  ComputedGetter,
  MaybeRef,
  MaybeRefOrGetter,
  Ref,
  UnwrapNestedRefs,
} from '@vue/reactivity'
import { computed, effect, isRef, reactive, ref, toRef, unref } from '@vue/reactivity'

// https://github.com/vueuse/vueuse/blob/ce09e0d03e0cac5884ad57bb87215428ac34917b/packages/shared/reactiveComputed/index.ts
/**
 * Computed reactive object.
 */
export function reactiveComputed<T extends object>(fn: ComputedGetter<T>): UnwrapNestedRefs<T> {
  return toReactive<T>(computed<T>(fn))
}

// https://github.com/vueuse/vueuse/blob/ce09e0d03e0cac5884ad57bb87215428ac34917b/packages/shared/toReactive/index.ts
/**
 * Converts ref to reactive.
 *
 * @see https://vueuse.org/toReactive
 * @param objectRef A ref of object
 */
export function toReactive<T extends object>(objectRef: MaybeRef<T>): UnwrapNestedRefs<T> {
  if (!isRef(objectRef)) return reactive(objectRef)

  const proxy = new Proxy(
    {},
    {
      get(_, p, receiver) {
        return unref(Reflect.get(objectRef.value, p, receiver))
      },
      set(_, p, value) {
        if (isRef((objectRef.value as any)[p]) && !isRef(value))
          (objectRef.value as any)[p].value = value
        else (objectRef.value as any)[p] = value
        return true
      },
      deleteProperty(_, p) {
        return Reflect.deleteProperty(objectRef.value, p)
      },
      has(_, p) {
        return Reflect.has(objectRef.value, p)
      },
      ownKeys() {
        return Object.keys(objectRef.value)
      },
      getOwnPropertyDescriptor() {
        return {
          enumerable: true,
          configurable: true,
        }
      },
    },
  )

  return reactive(proxy) as UnwrapNestedRefs<T>
}

export function refEffect<T>(getter: MaybeRefOrGetter<T>) {
  const getterRef = toRef(getter)
  const __ref = ref(getterRef.value as T)
  const _ref = __ref as Ref<T> & { reset: () => void }

  effect(() => {
    _ref.value = getterRef.value
  })

  _ref.reset = () => {
    _ref.value = getterRef.value
  }

  return _ref
}
