import * as postcss from "postcss";
import selectorParser = require("postcss-selector-parser");
import { CssBlockError } from "../errors";
import parseSelector, { ParsedSelector, CompoundSelector } from "../parseSelector";
import { stateParser, isClass, isState, isRoot, NodeAndType, BlockType, CLASS_NAME_IDENT } from "../BlockParser";
import { BlockClass } from "./index";
import { OptionsReader } from "../OptionsReader";
import { OutputMode } from "../OutputMode";
import { BlockObject, StateContainer } from "./BlockObject";
import { BlockScope } from "./LocalScope";
import { FileIdentifier } from "../importing";

export interface BlockReferenceMap {
  [blockName: string]: Block;
}

interface BlockClassMap {
  [className: string]: BlockClass;
}

export interface MergedObjectMap {
  [sourceName: string]: BlockObject[];
}

export class Block extends BlockObject {
  private _classes: BlockClassMap = {};
  private _blockReferences: BlockReferenceMap = {};
  private _identifier: FileIdentifier;
  private _base?: Block;
  private _baseName?: string;
  private _implements: Block[] = [];
  private _localScope: BlockScope;
  /**
   * array of paths that this block depends on and, if changed, would
   * invalidate the compiled css of this block. This is usually only useful in
   * preprocessed blocks.
   */
  private _dependencies: Set<string>;

  root?: postcss.Root;

  public readonly states: StateContainer;
  public readonly parsedRuleSelectors: WeakMap<postcss.Rule,ParsedSelector[]>;

  private hasHadNameReset = false;

  constructor(name: string, identifier: FileIdentifier) {
    super(name);
    this._identifier = identifier;
    this.parsedRuleSelectors = new WeakMap();
    this.states = new StateContainer(this);
    this._localScope = new BlockScope(this);
    this._dependencies = new Set<string>();
  }

  get name() {
    return this._name;
  }

  set name(name: string) {
    if ( this.hasHadNameReset ) {
      throw new CssBlockError('Can not set block name more than once.');
    }
    this._name = name;
    this.hasHadNameReset = true;
  }

  /**
   * Add an absolute, normalized path as a compilation dependency. This is used
   * to invalidate caches and trigger watchers when those files change.
   *
   * It is not necessary or helpful to add css-block files.
   */
  addDependency(filepath: string) {
    this._dependencies.add(filepath);
  }

  get dependencies(): string[] {
    return new Array(...this._dependencies);
  }

  get base(): Block | undefined {
    return this._base;
  }

  get baseName(): string | undefined {
    return this._baseName;
  }

  get identifier(): FileIdentifier {
    return this._identifier;
  }

  setBase(baseName: string, base: Block) {
    this._baseName = baseName;
    this._base = base;
  }

  getClass(name: string): BlockClass | undefined {
    return this._classes[name];
  }

  get implementsBlocks(): Block[] {
    return this._implements.concat([]);
  }

  addImplementation(b: Block) {
    return this._implements.push(b);
  }

  /**
   * Validate that this block implements all foreign selectors from blocks it impelemnts.
   * @param b The block to check implementation against.
   * @returns The BlockObjects from b that are missing in the block.
   */
  checkImplementation(b: Block): BlockObject[] {
    let missing: BlockObject[] = [];
    b.all().forEach((o: BlockObject) => {
      if (!this.find(o.asSource())) {
        missing.push(o);
      }
    });
    return missing;
  }

  /**
   * Validate that all foreign blocks this block implements are fully...implemented.
   */
  checkImplementations(): void {
    this.implementsBlocks.forEach((b: Block) => {
      let missingObjs: BlockObject[] = this.checkImplementation(b);
      let missingObjsStr = missingObjs.map(o => o.asSource()).join(", ");
      if (missingObjs.length > 0) {
        let s = missingObjs.length > 1 ? 's' : '';
        throw new CssBlockError( `Missing implementation${s} for: ${missingObjsStr} from ${b.identifier}`);
      }
    });
  }

  // This is a really dumb impl
  find(sourceName: string): BlockObject | undefined {
    let blockRefName: string | undefined;
     let md = sourceName.match(CLASS_NAME_IDENT);
     if (md && md.index === 0) {
       blockRefName = md[0];
       let blockRef: Block | undefined;
       this.eachBlockReference((name, block) => {
         if (blockRefName === name) {
           blockRef = block;
         }
       });
       if (blockRef) {
         if (md[0].length === sourceName.length) {
           return blockRef;
         }
         return blockRef.find(sourceName.slice(md[0].length));
       } else {
         return undefined;
       }
     }
    return this.all().find(e => e.asSource() === sourceName);
  }

  eachBlockReference(callback: (name: string, block: Block) => any) {
     Object.keys(this._blockReferences).forEach((name) => {
       callback(name, this._blockReferences[name]);
     });
   }

  get classes(): BlockClass[] {
    let classes: BlockClass[] = [];
    Object.keys(this._classes).forEach((e) => {
      classes.push(this._classes[e]);
    });
    return classes;
  }

  cssClass(opts: OptionsReader) {
    switch(opts.outputMode) {
      case OutputMode.BEM:
        return this.name;
      default:
        throw "this never happens";
    }
  }

  localName(): string {
    return "root";
  }

  addClass(blockClass: BlockClass) {
    this._classes[blockClass.name] = blockClass;
  }

  ensureClass(name: string): BlockClass {
    let blockClass;
    if (this._classes[name]) {
      blockClass = this._classes[name];
    } else {
      blockClass = new BlockClass(name, this);
      this.addClass(blockClass);
    }
    return blockClass;
  }

  addBlockReference(localName: string, other: Block) {
    this._blockReferences[localName] = other;
  }

  getReferencedBlock(localName: string): Block | null {
    return this._blockReferences[localName] || null;
  }

  transitiveBlockDependencies(): Set<Block> {
    let deps = new Set<Block>();
    this.eachBlockReference((_name, block) => {
      deps.add(block);
      let moreDeps = block.transitiveBlockDependencies();
      if (moreDeps.size > 0) {
        deps = new Set([...deps, ...moreDeps]);
      }
    });
    return deps;
  }

  /**
   * Return array self and all children.
   * @param shallow Pass false to not include inherited objects.
   * @returns Array of BlockObjects.
   */
  all(shallow?: boolean): BlockObject[] {
    let result: BlockObject[] = [this];
    result = result.concat(this.states.all());
    this.classes.forEach((blockClass) => {
      result = result.concat(blockClass.all());
    });
    if (!shallow && this.base) {
      result = result.concat(this.base.all(shallow));
    }
    return result;
  }

  /**
   * Lookup a sub-block either locally, or on a referenced foreign block.
   * @param reference A reference to a sub-block of the form `(<block-name>.)<sub-block-selector>`
   * @returns The BlockObject referenced at the supplied path.
   */
  lookup(reference: string): BlockObject | undefined {
    return this._localScope.lookup(reference);
  }

  merged(): MergedObjectMap {
    let map: MergedObjectMap = {};
    this.all().forEach((obj: BlockObject) => {
      let sourceName = obj.asSource();
      if (!map[sourceName]) {
        map[sourceName] = [];
      }
      map[sourceName].push(obj);
    });
    return map;
  }

  asSource():string {
    return `.root`;
  }

  /**
   * Fetch a the cached `BlockObject` from `Block` given `NodeAndType`.
   * @param obj The `NodeAndType` object to use for `BlockObject` lookup.
   */
  nodeAndTypeToBlockObject(obj: NodeAndType): BlockObject | undefined {
    switch (obj.blockType) {
      case BlockType.root:
        return this;
      case BlockType.state:
        return this.states._getState(stateParser(<selectorParser.Attribute>obj.node));
      case BlockType.class:
        return this.getClass(obj.node.value);
      case BlockType.classState:
        let classNode = obj.node.prev();
        let classObj = this.getClass(classNode.value);
        if (classObj) {
          return classObj.states._getState(stateParser(<selectorParser.Attribute>obj.node));
        }
    }
    return undefined;
  }

  nodeAsBlockObject(node: selectorParser.Node): [BlockObject, number] | null {
    if (node.type === selectorParser.CLASS && node.value === "root") {
      return [this, 0];
    } else if (node.type === selectorParser.TAG) {
      let otherBlock = this.getReferencedBlock(node.value);
      if (otherBlock) {
        let next = node.next();
        if (next && isClass(next)) {
          let klass = otherBlock.getClass(next.value);
          if (klass) {
            let another = next.next();
            if (another && isState(another)) {
              let info = stateParser(<selectorParser.Attribute>another);
              let state = klass.states._getState(info);
              if (state) {
                return [state, 2];
              } else {
                return null; // this is invalid and should never happen.
              }
            } else {
              // we don't allow scoped classes not part of a state
              return null; // this is invalid and should never happen.
            }
          } else {
            return null;
          }
        } else if (next && isState(next)) {
          let info = stateParser(<selectorParser.Attribute>next);
          let state = otherBlock.states._getState(info);
          if (state) {
            return [state, 1];
          } else {
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else if (node.type === selectorParser.CLASS) {
      let klass = this.getClass(node.value);
      if (klass === undefined) {
        return null;
      }
      let next = node.next();
      if (next && isState(next)) {
        let info = stateParser(<selectorParser.Attribute>next);
        let state = klass.states._getState(info);
        if (state === undefined) {
          return null;
        } else {
          return [state, 1];
        }
      } else {
        return [klass, 0];
      }
    } else if (isState(node)) {
      let info = stateParser(<selectorParser.Attribute>node);
      let state = this.states._ensureState(info);
      if (state) {
        return [state, 0];
      } else {
        return null;
      }
    }
    return null;
  }

  rewriteSelectorNodes(nodes: selectorParser.Node[], opts: OptionsReader): selectorParser.Node[] {
    let newNodes: selectorParser.Node[] = [];
    for (let i = 0; i < nodes.length; i++) {
      let node = nodes[i];
      let result = this.nodeAsBlockObject(node);
      if (result === null) {
        newNodes.push(node);
      } else {
        newNodes.push(selectorParser.className({value: result[0].cssClass(opts)}));
        i += result[1];
      }
    }
    return newNodes;
  }

  rewriteSelectorToString(selector: ParsedSelector, opts: OptionsReader): string {
    let firstNewSelector = new CompoundSelector();
    let newSelector = firstNewSelector;
    let newCurrentSelector = newSelector;
    let currentSelector: CompoundSelector | undefined = selector.selector;
    do {
      newCurrentSelector.nodes = this.rewriteSelectorNodes(currentSelector.nodes, opts);
      newCurrentSelector.pseudoelement = currentSelector.pseudoelement;
      if (currentSelector.next !== undefined) {
        let tempSel = newCurrentSelector;
        newCurrentSelector = new CompoundSelector();
        tempSel.setNext(currentSelector.next.combinator, newCurrentSelector);
        currentSelector = currentSelector.next.selector;
      } else {
        currentSelector = undefined;
      }
    } while (currentSelector !== undefined);
    return firstNewSelector.toString();
  }

  rewriteSelector(selector: ParsedSelector, opts: OptionsReader): ParsedSelector {
    // generating a string and reparsing ensures the internal structure is consistent
    // otherwise the parent/next/prev relationships will be wonky with the new nodes.
    return parseSelector(this.rewriteSelectorToString(selector, opts))[0];
  }

  matches(compoundSel: CompoundSelector): boolean {
    return compoundSel.nodes.some(node => isRoot(node));
  }

  debug(opts: OptionsReader): string[] {
    let result: string[] = [`Source: ${this.identifier}`, this.asDebug(opts)];
    let sourceNames = new Set<string>(this.all().map(o => o.asSource()));
    let sortedNames = [...sourceNames].sort();
    sortedNames.forEach(n => {
      if (n !== ".root") {
        let o = this.find(n) as BlockObject;
        result.push(o.asDebug(opts));
      }
    });
    return result;
  }

  /**
   * Test if the supplied block is the same block object.
   * @param other  The other Block to test against.
   * @return True or False if self and `other` are equal.
   */
  equal(other: Block | undefined | null) {
    return other && this.identifier === other.identifier;
  }

  isAncestor(other: Block | undefined | null): boolean {
    let base: Block | undefined | null = other && other.base;
    while (base) {
      if (this.equal(base)) {
        return true;
      } else {
        base = base.base;
      }
    }
    return false;
  }

  /**
   * TODO: Move selector cache into `parseSelector` and have consumers of this
   *       method interface with the parseSelector utility directly.
   * Given a PostCSS Rule, ensure it is present in this Block's parsed rule
   * selectors cache, and return the ParsedSelector array.
   * @param rule  PostCSS Rule
   * @return ParsedSelector array
   */
  getParsedSelectors(rule: postcss.Rule): ParsedSelector[] {
    let sels = this.parsedRuleSelectors.get(rule);
    if (!sels) {
      sels = parseSelector(rule.selector);
      this.parsedRuleSelectors.set(rule, sels);
    }
    return sels;
  }

  /**
   * Objects that contain Blocks are often passed into assorted libraries' options
   * hashes. Some libraries like to `JSON.stringify()` their options to create
   * unique identifiers for re-run caching. (ex: Webpack, awesome-typescript-loader)
   * Blocks contain circular dependencies, so we need to override their `toJSON`
   * method so these libraries don't implode.
   * @return The name of the block.
   */
  toJSON(){
    return this._name;
  }
}
