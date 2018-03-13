import {
  AST,
  NodeVisitor,
  Syntax,
} from "@glimmer/syntax";
import { whatever } from "@opticss/util";
import {
  Block,
  PluginOptions as CssBlocksOpts,
  PluginOptionsReader as CssBlocksOptionsReader,
  StyleMapping,
  TemplateAnalysis,
} from "css-blocks";
import * as debugGenerator from "debug";

import { classnamesHelper } from "./ClassnamesHelperGenerator";
import { ElementAnalyzer } from "./ElementAnalyzer";
import { ResolvedFile } from "./GlimmerProject";

const DEBUG = debugGenerator("css-blocks:glimmer");

// TODO: The state namespace should come from a config option.
const STYLE_ATTR = /^(class$|state:)/;

export class Rewriter implements NodeVisitor {
  template: ResolvedFile;
  analysis: TemplateAnalysis<"GlimmerTemplates.ResolvedFile">;
  elementCount: number;
  syntax: Syntax;
  block: Block;
  styleMapping: StyleMapping;
  cssBlocksOpts: CssBlocksOptionsReader;

  private elementAnalyzer: ElementAnalyzer;

  constructor(
    syntax: Syntax,
    styleMapping: StyleMapping,
    analysis: TemplateAnalysis<"GlimmerTemplates.ResolvedFile">,
    cssBlocksOpts: CssBlocksOpts,
  ) {
    this.syntax        = syntax;
    this.analysis      = analysis;
    this.template      = <ResolvedFile>analysis.template;
    this.block         = analysis.blocks[""];
    this.styleMapping  = styleMapping;
    this.cssBlocksOpts = new CssBlocksOptionsReader(cssBlocksOpts);
    this.elementCount  = 0;
    this.elementAnalyzer = new ElementAnalyzer(this.block, this.template, this.cssBlocksOpts);
  }

  debug(message: string, ...args: whatever[]): void {
    DEBUG(`${this.template.fullPath}: ${message}`, ...args);
  }

  ElementNode(node: AST.ElementNode) {
    this.elementCount++;
    let atRootElement = (this.elementCount === 1);
    let element = this.elementAnalyzer.analyzeForRewrite(node, atRootElement);
    if (DEBUG.enabled) this.debug(element.forOptimizer(this.cssBlocksOpts)[0].toString());
    let rewrite = this.styleMapping.simpleRewriteMapping(element);

    // Remove all the source attributes for styles.
    node.attributes = node.attributes.filter(a => !STYLE_ATTR.test(a.name));

    if (rewrite.dynamicClasses.length === 0) {
      if (rewrite.staticClasses.length === 0) {
        // there's no styles. we're done.
        return;
      }

      // It's a simple text node of static classes.
      let value = this.syntax.builders.text(rewrite.staticClasses.join(" "));
      let classAttr = this.syntax.builders.attr("class", value);
      node.attributes.unshift(classAttr);
      return;
    }

    let dynamicNode = classnamesHelper(rewrite, element);
    let classValue: AST.MustacheStatement | AST.ConcatStatement;
    let staticNode: AST.TextNode | undefined = undefined;
    if (rewrite.staticClasses.length > 0) {
      staticNode = this.syntax.builders.text(rewrite.staticClasses.join(" ") + " ");
      classValue = this.syntax.builders.concat([staticNode, dynamicNode]);
    } else {
      classValue = dynamicNode;
    }

    node.attributes.unshift(this.syntax.builders.attr("class", classValue));

    return;
  }
}
