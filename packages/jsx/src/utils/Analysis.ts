import {
  SerializedTemplateInfo,
  TemplateInfo,
  TemplateInfoFactory,
} from "@opticss/template-api";
import { Maybe, none, ObjectDictionary, whatever } from "@opticss/util";
import { File } from "babel-types";
import {
  Block,
  MetaTemplateAnalysis,
  TemplateAnalysis,
} from "css-blocks";

declare module "@opticss/template-api" {
  interface TemplateTypes {
    "Opticss.JSXTemplate": JSXTemplate;
  }
}

export class JSXTemplate implements TemplateInfo<"Opticss.JSXTemplate"> {
  identifier: string;
  type: "Opticss.JSXTemplate" = "Opticss.JSXTemplate";
  data: string;
  ast: Maybe<File>;

  constructor(identifier: string, data: string) {
    this.identifier = identifier;
    this.data = data;
    this.ast = none("The template was not yet parsed.");
  }

  static deserialize(identifier: string, ..._data: whatever[]): JSXTemplate {
    return new JSXTemplate(identifier, <string>_data[0]);
  }

  serialize(): SerializedTemplateInfo<"Opticss.JSXTemplate"> {
    return {
      type: this.type,
      identifier: this.identifier,
      data: [ this.data ],
    };
  }
}

TemplateInfoFactory.constructors["Opticss.JSXTemplate"] = JSXTemplate.deserialize;

/**
* Extension of the default css-bocks analytics object to store blocks and other
* files discovered in the dependency tree.
*/
export class Analysis extends TemplateAnalysis<"Opticss.JSXTemplate"> {

  template: JSXTemplate;
  parent: MetaAnalysis;
  blockPromises: Promise<Block>[] = [];

  constructor(template: JSXTemplate, parent: MetaAnalysis) {
    super(template);
    this.template = template;
    this.parent = parent;
  }

}

/**
 * Container for file specific state for any file discovered in the dependency tree.
 */
export class MetaAnalysis extends MetaTemplateAnalysis {

  files: JSXTemplate[] = [];
  analysisPromises: Promise<Analysis>[] = [];
  blockPromises: ObjectDictionary<Promise<Block>> = {};

  fileCount(): number {
    return this.analyses.length;
  }

  blockCount(): number {
    let blocks: Set<Block> = new Set();
    this.eachAnalysis((analysis) => {
      let keys = Object.keys(analysis.blocks);
      keys.forEach((key) => {
        blocks.add(analysis.blocks[key]);
      });
    });
    return blocks.size;
  }

  blockPromisesCount(): number {
    return Object.keys(this.blockPromises).length;
  }

  getAnalysis(idx: number): Analysis {
    let analysis = this.analyses[idx];
    if (analysis.template.type === "Opticss.JSXTemplate") {
      // Cast through any to force return type.
      // tslint:disable-next-line:prefer-whatever-to-any
      return (<any>analysis) as Analysis;
    } else {
      throw new Error(`analysis at ${idx} is not a jsx analysis`);
    }
  }

}
