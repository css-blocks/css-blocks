import * as postcss from "postcss";
import { PluginOptions, OptionsReader } from "./options";
import { MergedObjectMap, Block } from "./Block";
import ConflictResolver from "./ConflictResolver";
import { StyleAnalysis } from "./TemplateAnalysis/StyleAnalysis";
import parseBlockDebug from "./parseBlockDebug";
/**
 * Compiler that, given a Block will return a transformed AST
 * interface is `BlockParser.parse`.
 */
export default class BlockCompiler {
  private opts: OptionsReader;
  private postcss: typeof postcss;

  constructor(postcssImpl: typeof postcss, opts?: PluginOptions) {
    this.opts = new OptionsReader(opts);
    this.postcss = postcssImpl;
  }

  compile(block: Block, root: postcss.Root, analysis?: StyleAnalysis): postcss.Root {
      if (analysis) {
        // console.log("Got an analysis for compilation. I should use it probably.", analysis);
      }
      let resolver = new ConflictResolver(this.opts);
      let filename = this.opts.importer.debugIdentifier(block.identifier, this.opts);
      // Process all debug statements for this block.
      this.processDebugStatements(filename, root, block);

      // Clean up CSS Block specific properties.
      root.walkAtRules("block-reference", (atRule) => {
        atRule.remove();
      });
      root.walkRules(/\.root/, (rule) => {
        rule.walkDecls(/^(extends|implements|block-name)$/, (decl) => {
          decl.remove();
        });
        if (rule.nodes === undefined || rule.nodes.length === 0) {
          rule.remove();
        }
      });

      // Resolve inheritance based conflicts
      resolver.resolveInheritance(root, block);
      root.walkRules((rule) => {
        let parsedSelectors = block.getParsedSelectors(rule);
        rule.selector = parsedSelectors.map(s => block.rewriteSelectorToString(s, this.opts)).join(",\n");
      });
      resolver.resolve(root, block);

      if (this.opts.interoperableCSS) {
        this.injectExports(root, block);
      }
      return root;
  }

  /**
   * Process all `@block-debug` statements, output debug statement to console or in comment as requested.
   * @param sourceFile File name of block in question.
   * @param root PostCSS Root for block.
   * @param block Block to resolve references for
   */
  public processDebugStatements(sourceFile: string, root: postcss.Root, block: Block) {
    root.walkAtRules("block-debug", (atRule) => {
      let {block: ref, channel} = parseBlockDebug(atRule, sourceFile, block);
      if (channel === "comment") {
        let debugStr = ref.debug(this.opts);
        atRule.replaceWith(this.postcss.comment({text: debugStr.join("\n   ")}));
      } else {
        // stderr/stdout are emitted during parse.
        atRule.remove();
      }
    });
  }

  private injectExports(root: postcss.Root, block: Block) {
    let exportsRule = this.postcss.rule({selector: ":export"});
    root.prepend(exportsRule);
    let objsMap: MergedObjectMap = block.merged();
    Object.keys(objsMap).forEach((name) => {
      let objs = objsMap[name];
      exportsRule.append(this.postcss.decl({
        prop: objs[0].localName(),
        value: objs.map(obj => obj.cssClass(this.opts)).join(" ")
      }));
    });
  }
}
