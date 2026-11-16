# Form

The language of `@falcondev-oss/form`: a schema-driven form state library with adapters for React and Vue.

## Language

### Data

**Form data**:
The current values of the form, in the shape of the schema input. It is read-only; it changes only through a field, an array operation or a recipe.
_Avoid_: State, model, values

**Source values**:
The values the form starts from and returns to on reset.
_Avoid_: Initial values, defaults

**Recipe**:
A function that describes several edits to the form data as one change.
_Avoid_: Mutation, patch, updater

**Array operation**:
An explicit edit of an array's items: insert, remove, move, swap or sort.
_Avoid_: Array mutation, array method

### Fields

**Field**:
The form's view of one value: the value itself, its errors, and whether it is dirty or changed.
_Avoid_: Input, control

**Field state**:
What the form keeps for one value besides the value itself: its item key, whether it is dirty, and its errors. Every value has it, primitives included.
_Avoid_: Metadata, meta

**Schema metadata**:
The facts about a value that come from the schema, such as whether it is required and its limits.
_Avoid_: Metadata, field state

**Accessor**:
An address of a value in the form, from which a field is taken. The accessor of an item stays with that item when the item changes position.
_Avoid_: Field proxy, field path object

**Dirty**:
A field or form the user has edited since it was last pristine.
_Avoid_: Touched, modified

**Changed**:
A field or form whose value differs from the source value at the same path. Unlike field state, it does not move with an item.
_Avoid_: Dirty, modified

### Arrays

**Item**:
One entry of an array in the form data, of any type: object, array or primitive.
_Avoid_: Element, row, entry

**Item key**:
The stable identifier of an item. It stays with the item when the item changes position.
_Avoid_: Index, id

**Key property**:
A property of an item's own value, such as `id`, that the form can use to recognize the item when its array is replaced. It is optional and is not the item key.
_Avoid_: Item key, id

**Detached field**:
A field whose item was removed from the form data. It keeps its last value and accepts no changes.
_Avoid_: Dead field, orphan

**Identity semantics**:
The rule that a field belongs to its item, not to the item's index. Reordering an array moves each field with its item.
_Avoid_: Positional semantics (the opposite rule)

### Paths

**Path**:
The current position of a value in the form data, written as text.
_Avoid_: Key, name

**Segment**:
One step of a path. A number is an array index; a string is an object key.
_Avoid_: Part, path element
