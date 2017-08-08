import { assert } from "chai";
import * as postcss from "postcss";
import cssBlocks from "../../src/cssBlocks";
import { Block } from "../../src/Block";

export default function assertError(errorType: typeof cssBlocks.CssBlockError, message: string, promise: postcss.LazyResult) {
  return promise.then(
    () => {
      assert(false, `Error ${errorType.name} was not raised.`);
    },
    (reason) => {
      assert(reason instanceof errorType, reason.toString());
      assert.deepEqual(reason.message.split(errorType.prefix+':')[1].trim(), message);
    });
}

export function assertParseError(errorType: typeof cssBlocks.CssBlockError, message: string, promise: Promise<any>) {
  return promise.then(
    () => {
      assert(false, `Error ${errorType.name} was not raised.`);
    },
    (reason) => {
      assert(reason instanceof errorType, reason.toString());
      assert.deepEqual(reason.message.split(errorType.prefix+':')[1].trim(), message);
    });
}
