// The types of `bun:test`, and nothing else from Bun. Tests run on `bun test`; the packages run on Node.js, so the
// `Bun` global and the rest of bun-types must stay invisible to the code under test.
import 'bun-types/test.js'
