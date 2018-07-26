import * as assert from "assert";
import * as path from "path";

import { GlimmerAnalyzer } from "@css-blocks/glimmer";
import { TempDir, buildOutput, createTempDir } from "broccoli-test-helper";

import { BroccoliCSSBlocks } from "../src/index";

describe("Broccoli Plugin Test", function () {
  let input: TempDir;

  beforeEach(async () => {
    input = await createTempDir();
  });

  afterEach(async () => {
    await input.dispose();
  });

  describe("Broccoli Plugin Test", () => {
    it("runs tests", () => {
      assert.ok(1);
    });

    it("outputs CSS file and populates transport object", async () => {
      const entryComponentName = "Chrisrng";

      input.write({
        "package.json": `{
          "name": "chrisrng-test"
        }`,
        src: {
          ui: {
            components: {
              [entryComponentName]: {
                "template.hbs": `<div><h1 class="foo">Welcome to Glimmer!</h1></div>`,
                "stylesheet.css": `
                  :scope {
                    color: red;
                  }

                  .foo {
                    color: green;
                  }
                `,
              },
            },
          },
        },
      });

      let transport = { id: "test-transport" };
      let analyzer = new GlimmerAnalyzer({}, {}, {
        app: { name: "test" },
        types: {
          stylesheet: { definitiveCollection: "components" },
          template: { definitiveCollection: "components" },
        },
        collections: {
          components: { group: "ui", types: [ "template", "stylesheet" ] },
        },
      });

      let compiler = new BroccoliCSSBlocks(input.path(), {
        entry: [entryComponentName],
        root: path.join(__dirname, "../.."),
        output: "css-blocks.css",
        transport,
        analyzer,
      });
      await buildOutput(compiler);

      assert.ok(Object.keys(transport).length, "Transport Object populated");
      assert.ok(transport["mapping"], "Mapping property is populated in Transport Object");
      assert.ok(transport["blocks"], "Blocks property is populated in Transport Object");
      assert.ok(transport["analyzer"], "Analyzer property is populated in Transport Object");
      assert.ok(transport["css"], "CSS property is populated in Transport Object");
    });
  });
});
