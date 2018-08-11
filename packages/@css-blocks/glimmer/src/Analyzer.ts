
import {  Analysis,
  AnalysisOptions,
  Analyzer,
  Block,
  BlockClass,
  BlockFactory,
  Options,
} from "@css-blocks/core";
import { ResolverConfiguration } from "@glimmer/resolver";
import { preprocess, traverse } from "@glimmer/syntax";
import { TemplateIntegrationOptions } from "@opticss/template-api";
import * as debugGenerator from "debug";
import { postcss } from "opticss";

import { ElementAnalyzer } from "./ElementAnalyzer";
import { Resolver } from "./Resolver";
import { TEMPLATE_TYPE } from "./Template";

export type AttributeContainer = Block | BlockClass;
export type GlimmerAnalysis = Analysis<TEMPLATE_TYPE>;

export class GlimmerAnalyzer extends Analyzer<TEMPLATE_TYPE> {
  projectDir: string;
  srcDir: string;
  blockFactory: BlockFactory;
  resolver: Resolver;
  debug: debugGenerator.IDebugger;

  constructor(
    projectDir: string,
    srcDir: string,
    moduleConfig?: ResolverConfiguration,
    cssBlocksOpts?: Options,
    analysisOpts?: AnalysisOptions,
  ) {
    super(cssBlocksOpts, analysisOpts);

    this.projectDir = projectDir;
    this.srcDir = srcDir;
    this.blockFactory = new BlockFactory(this.cssBlocksOptions, postcss);
    this.resolver = new Resolver(projectDir, srcDir, moduleConfig);
    this.debug = debugGenerator("css-blocks:glimmer:analyzer");
  }

  reset() {
    super.reset();
    this.blockFactory.reset();
  }

  get optimizationOptions(): TemplateIntegrationOptions {
    return {
      rewriteIdents: {
        id: false,
        class: true,
        omitIdents: {
          id: [],
          class: [],
        },
      },
      analyzedAttributes: ["class"],
      analyzedTagnames: true,
    };
  }

  async analyze(...componentNames: string[]): Promise<GlimmerAnalyzer> {

    let components = new Set<string>();
    let analysisPromises: Promise<GlimmerAnalysis>[] = [];
    this.debug(`Analyzing all templates starting with: ${componentNames}`);

    componentNames.forEach(componentName => {
      components.add(componentName);
      try {
        let componentDeps = this.resolver.recursiveDependenciesForTemplate(componentName);
        componentDeps.forEach(c => components.add(c));
      } catch(e){
        this.debug(`Warning: Could not discover recursive dependencies for component ${componentName}`);
      }
    });

    this.debug(`Analyzing all components: ${[...components].join(", ")}`);

    components.forEach(dep => {
      analysisPromises.push(this.analyzeTemplate(dep));
    });

    await Promise.all(analysisPromises);
    return this;
  }

  private async resolveBlock(componentName: string): Promise<Block | undefined> {
    try {
      let blockFile = await this.resolver.stylesheetFor(componentName);
      if (!blockFile) {
        this.debug(`Analyzing ${componentName}. No block for component. Returning empty analysis.`);
        return undefined;
      }
      return await this.blockFactory.getBlockFromPath(blockFile.path);
    } catch (e) {
      console.error(e);
      this.debug(`Analyzing ${componentName}. No block for component. Returning empty analysis.`);
      return undefined;
    }
  }

  protected async analyzeTemplate(componentName: string): Promise<GlimmerAnalysis> {
    this.debug("Analyzing template: ", componentName);
    let template = await this.resolver.templateFor(componentName);
    if (!template) {
      throw new Error(`Unable to resolve template for component ${componentName}`);
    }
    let analysis = this.newAnalysis(template);
    let ast = preprocess(template.string);
    let elementCount = 0;
    let self = this;

    // Fetch the block associated with this template. If no block file for this
    // component exists, does not exist, stop.
    let block: Block | undefined = await this.resolveBlock(componentName);
    if (!block) { return analysis; }

    analysis.addBlock("", block);
    self.debug(`Analyzing ${componentName}. Got block for component.`);

    // Add all transitive block dependencies
    let localBlockNames: string[] = [];
    analysis.addBlock("", block);
    localBlockNames.push("<default>");
    block.eachBlockReference((name, refBlock) => {
      analysis.addBlock(name, refBlock);
      localBlockNames.push(name);
    });
    self.debug(`Analyzing ${componentName}. ${localBlockNames.length} blocks in scope: ${localBlockNames.join(", ")}.`);

    let elementAnalyzer = new ElementAnalyzer(analysis, this.cssBlocksOptions);
    traverse(ast, {
      ElementNode(node) {
        elementCount++;
        let atRootElement = (elementCount === 1);
        let element = elementAnalyzer.analyze(node, atRootElement);
        if (self.debug.enabled) self.debug("Element analyzed:", element.forOptimizer(self.cssBlocksOptions).toString());
      },
    });
    return analysis;
  }
}
