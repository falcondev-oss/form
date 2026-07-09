// Field metadata extraction. Implemented by a dependency-free JSON-Schema navigator
// (see ./schema-navigator) that resolves discriminated-union branches against the
// current form data — replacing the previous `json-schema-library` dependency, whose
// `getNode` returned `one-of-error` for any path through a union.
export { getSchemaMeta } from './schema-navigator'
