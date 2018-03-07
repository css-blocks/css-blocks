import { assert } from "chai";
import { suite, test } from "mocha-typescript";
import * as postcss from "postcss";

import cssBlocks, {
  BlockFactory,
  PluginOptions,
  PluginOptionsReader,
} from "../src";

import { BEMProcessor } from "./util/BEMProcessor";
import { MockImportRegistry } from "./util/MockImportRegistry";

@suite("Block Factory")
export class BlockFactoryTests extends BEMProcessor {
  assertError(errorType: typeof cssBlocks.CssBlockError, message: string, promise: postcss.LazyResult) {
    return promise.then(
      () => {
        assert(false, `Error ${errorType.name} was not raised.`);
      },
      (reason) => {
        assert(reason instanceof errorType, reason.toString());
        assert.deepEqual(reason.message, message);
      });
  }

  @test "can import a block"() {
    let imports = new MockImportRegistry();
    let baseFilename = "foo/bar/base.css";
    imports.registerSource(
      baseFilename,
      `:scope { color: purple; }
       [state|large] { font-size: 20px; }
       .foo   { float: left;   }
       .foo[state|small] { font-size: 5px; }`,
    );

    let extendsFilename = "foo/bar/extends.css";
    imports.registerSource(
      extendsFilename,
      `@block-reference base from "./base.css";
       :scope { extends: base; color: red; }`,
    );
    let importer = imports.importer();
    let options: PluginOptions = {importer: importer};
    let reader = new PluginOptionsReader(options);
    let factory = new BlockFactory(reader, postcss);
    let extendsBlockPromise = factory.getBlock(importer.identifier(null, extendsFilename, reader));
    let baseBlockPromise = factory.getBlock(importer.identifier(null, baseFilename, reader));
    return Promise.all([extendsBlockPromise, baseBlockPromise]).then(([extendsBlock, baseBlock]) => {
      assert.strictEqual(extendsBlock.base, baseBlock);
    });
  }

  @test "handles blocks with the same name"() {
    let imports = new MockImportRegistry();

    let blockFilename1 = "foo/bar/block_1.css";
    imports.registerSource(
      blockFilename1,
      `:scope {
         block-name: block;
         color: red;
       }`,
    );

    let blockFilename2 = "foo/bar/block_2.css";
    imports.registerSource(
    blockFilename2,
    ` @block-reference external from "./block_1.css";
      :scope {
        block-name: block;
        color: red;
      }
    `);

    let importer = imports.importer();
    let options: PluginOptions = {importer: importer};
    let reader = new PluginOptionsReader(options);
    let factory = new BlockFactory(reader, postcss);

    let blockPromise1 = factory.getBlock(importer.identifier(null, blockFilename1, reader));
    let blockPromise2 = factory.getBlock(importer.identifier(null, blockFilename2, reader));
    return Promise.all([blockPromise1, blockPromise2]).then(([block1, block2]) => {
      assert.equal(block1.name, "block");
      assert.equal(block2.name, "block-2");
    });

  }

}
