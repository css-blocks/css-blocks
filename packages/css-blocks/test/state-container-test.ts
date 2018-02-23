import { assert as typedAssert } from "@opticss/util";
import { assert } from "chai";
import { suite, test } from "mocha-typescript";
import * as postcss from "postcss";

import {
  BlockFactory,
} from "../src/BlockFactory";
import {
  OptionsReader,
} from "../src/OptionsReader";
import cssBlocks = require("../src/cssBlocks");
import { State, StateGroup } from "../src/index";
import {
  PluginOptions,
} from "../src/options";

import { BEMProcessor } from "./util/BEMProcessor";
import { MockImportRegistry } from "./util/MockImportRegistry";

@suite("State container")
export class StateContainerTest extends BEMProcessor {
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

  @test "finds boolean states"() {
    let imports = new MockImportRegistry();
    let filename = "foo/bar/a-block.css";
    imports.registerSource(
      filename,
      `[state|large] { font-size: 20px; }
       .foo   { float: left;   }
       .foo[state|small] { font-size: 5px; }`,
    );

    let importer = imports.importer();
    let options: PluginOptions = {importer: importer};
    let reader = new OptionsReader(options);
    let factory = new BlockFactory(reader, postcss);

    return factory.getBlock(importer.identifier(null, filename, reader)).then(block => {
      let state = block.rootClass.getState("large");
      typedAssert.isNotNull(state).and((state) => {
        assert.equal(state.name, "large");
      });
      let classObj = block.getClass("foo");
      typedAssert.isNotNull(classObj).and(classObj => {
        let classState = classObj.getState("small");
        typedAssert.isNotNull(classState).and(classState => {
          assert.equal(classState.name, "small");
        });
      });
    });
  }
  @test "finds state groups"() {
    let imports = new MockImportRegistry();
    let filename = "foo/bar/a-block.css";
    imports.registerSource(
      filename,
      `[state|size=large] { font-size: 20px; }
       [state|size=small] { font-size: 10px; }
       [state|active] { color: red; }
       .foo[state|mode=collapsed] { display: none; }
       .foo[state|mode=minimized] { display: block; max-height: 100px; }
       .foo[state|mode=expanded] { display: block; }`,
    );

    let importer = imports.importer();
    let options: PluginOptions = {importer: importer};
    let reader = new OptionsReader(options);
    let factory = new BlockFactory(reader, postcss);

    return factory.getBlock(importer.identifier(null, filename, reader)).then(block => {
      let sizeGroup: Array<State> = block.rootClass.getGroup("size");
      assert.equal(sizeGroup.length, 2);
      assert.includeMembers(sizeGroup.map(s => s.name), ["large", "small"]);
      let subtateGroup: Array<State> = block.rootClass.getGroup("size", "large");
      assert.equal(subtateGroup.length, 1);
      assert.includeMembers(subtateGroup.map(s => s.name), ["large"]);
      let missingGroup: Array<State> = block.rootClass.getGroup("asdf");
      assert.equal(missingGroup.length, 0);
      let missingSubstate: Array<State> = block.rootClass.getGroup("size", "tiny");
      assert.equal(missingSubstate.length, 0);
      typedAssert.isNotNull(block.getClass("foo")).and(classObj => {
        let modeGroup: Array<State> = classObj.getGroup("mode");
        assert.equal(modeGroup.length, 3);
        assert.includeMembers(modeGroup.map(s => s.name), ["collapsed", "minimized", "expanded"]);
      });
    });
  }
  @test "resolves inherited state groups"() {
    let imports = new MockImportRegistry();
    let filename = "foo/bar/sub-block.block.css";
    imports.registerSource(
      "foo/bar/base-block.block.css",
      `[state|size=large] { font-size: 20px; }
       [state|size=small] { font-size: 10px; }
       [state|active] { color: red; }
       .foo[state|mode=collapsed] { display: none; }
       .foo[state|mode=minimized] { display: block; max-height: 100px; }
       .foo[state|mode=expanded] { display: block; }`,
    );
    imports.registerSource(
      filename,
      `@block-reference base-block from "base-block.block.css";
       .root { extends: base-block; }
       [state|size=tiny] { font-size: 6px; }
       .foo[state|mode=minimized] { display: block; max-height: 200px; }`,
    );

    let importer = imports.importer();
    let options: PluginOptions = {importer: importer};
    let reader = new OptionsReader(options);
    let factory = new BlockFactory(reader, postcss);

    return factory.getBlock(importer.identifier(null, filename, reader)).then(block => {
      let sizeGroup = block.rootClass.resolveGroup("size") || {};
      let sizeGroupNames = Object.keys(sizeGroup);
      assert.equal(sizeGroupNames.length, 3);
      assert.includeMembers(sizeGroupNames, ["large", "small", "tiny"]);
      typedAssert.isNotNull(block.getClass("foo")).and(classObj => {
        let modeGroup = classObj.resolveGroup("mode") || {};
        let modeGroupNames = Object.keys(modeGroup);
        assert.equal(modeGroupNames.length, 3);
        typedAssert.isDefined(modeGroup).and(modeGroup => {
          typedAssert.isDefined(modeGroup["collapsed"]).and(state => {
            assert.equal(state.block, block.base);
          });
          typedAssert.isDefined(modeGroup["minimized"]).and(state => {
            assert.equal(state.block, block);
          });
        });
      });
    });
  }
}
