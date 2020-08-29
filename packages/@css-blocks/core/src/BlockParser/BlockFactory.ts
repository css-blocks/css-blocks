import { ObjectDictionary, isString } from "@opticss/util";
import * as debugGenerator from "debug";
import { LegacyRawSourceMap, adaptFromLegacySourceMap, parseSelector, postcss } from "opticss";
import * as path from "path";
import { RawSourceMap } from "source-map";

import { Block } from "../BlockTree";
import { Styles } from "../BlockTree/Styles";
import { Options, ResolvedConfiguration, resolveConfiguration } from "../configuration";
import { CssBlockError } from "../errors";
import { FileIdentifier, ImportedCompiledCssFile, ImportedFile, Importer } from "../importing";
import { upgradeDefinitionFileSyntax } from "../PrecompiledDefinitions/block-syntax-version";
import { PromiseQueue } from "../util/PromiseQueue";

import { BlockParser, ParsedSource } from "./BlockParser";
import { Preprocessor, Preprocessors, ProcessedFile, Syntax, annotateCssContentWithSourceMap, syntaxName } from "./preprocessing";

const debug = debugGenerator("css-blocks:BlockFactory");

interface PreprocessJob {
  preprocessor: Preprocessor;
  filename: string;
  contents: string;
}

interface ErrorWithErrNum {
  code?: string;
  message: string;
}

/**
 * This factory ensures that instances of a block are re-used when blocks are
 * going to be compiled/optimized together. Multiple instances of the same
 * block will result in analysis and optimization bugs.
 *
 * This also ensures that importers and preprocessors are correctly used when loading a block file.
 */
export class BlockFactory {
  postcssImpl: typeof postcss;
  importer: Importer;
  configuration: ResolvedConfiguration;
  blockNames: ObjectDictionary<string>;
  parser: BlockParser;
  preprocessors: Preprocessors;
  faultTolerant: boolean;

  private promises: ObjectDictionary<Promise<Block>>;
  private blocks: ObjectDictionary<Block>;
  private paths: ObjectDictionary<string>;
  private preprocessQueue: PromiseQueue<PreprocessJob, ProcessedFile>;

  private guids = new Set<string>();

  constructor(options: Options, postcssImpl = postcss, faultTolerant = false) {
    this.postcssImpl = postcssImpl;
    this.configuration = resolveConfiguration(options);
    this.importer = this.configuration.importer;
    this.preprocessors = this.configuration.preprocessors;
    this.parser = new BlockParser(options, this);
    this.blocks = {};
    this.blockNames = {};
    this.promises = {};
    this.paths = {};
    this.preprocessQueue = new PromiseQueue(this.configuration.maxConcurrentCompiles, (item: PreprocessJob) => {
      return item.preprocessor(item.filename, item.contents, this.configuration);
    });
    this.faultTolerant = faultTolerant;
  }

  /**
   * Toss out any caches in this BlockFactory. Any future requests for a block
   * or block path will be loaded fresh from persistent storage.
   */
  reset() {
    this.blocks = {};
    this.paths = {};
    this.promises = {};
    this.blockNames = {};
    this.guids.clear();
  }

  /**
   * Parse a `postcss.Root` into a Block object. Save the Block promise and
   * return it. Use parseRoot if we need to catch errors.
   *
   * This function is referenced only in tests.
   * @param root The postcss.Root to parse.
   * @param identifier A unique identifier for this Block file.
   * @param name Default name for the block.
   * @param isDfnFile Whether to treat this as a definition file.
   * @returns The Block object promise.
   */
  parseRootFaultTolerant(root: postcss.Root, identifier: string, name: string, isDfnFile = false, expectedGuid?: string): Promise<Block> {
    return this.promises[identifier] = this.parser.parse(root, identifier, name, isDfnFile, expectedGuid);
  }

  /**
   * Parse a `postcss.Root` into a Block object. Save the Block promise and return it.
   * Also assert that the block is valid so that we can catch any errors that
   * the block contains.
   *
   * This function is only used in tests
   * @param root The postcss.Root to parse.
   * @param identifier A unique identifier for this Block file.
   * @param name Default name for the block.
   * @param isDfnFile Whether to treat this as a definition file.
   * @returns The Block object promise.
   */
  async parseRoot(root: postcss.Root, identifier: string, name: string, isDfnFile = false, expectedGuid?: string): Promise<Block> {
    const block = await this.parseRootFaultTolerant(root, identifier, name, isDfnFile, expectedGuid);
    return this._surfaceBlockErrors(block);
  }

  /**
   * In some cases (like when using preprocessors with native bindings), it may
   * be necessary to wait until the block factory has completed current
   * asynchronous work before exiting. Calling this method stops new pending
   * work from being performed and returns a promise that resolves when it is
   * safe to exit.
   */
  prepareForExit(): Promise<void> {
    if (this.preprocessQueue.activeJobCount > 0) {
      return this.preprocessQueue.drain();
    } else {
      return Promise.resolve();
    }
  }

  /**
   * Given a file path (or other data path reference), load data from storage and parse it
   * into a CSS Block.
   *
   * @param filePath - The path to the file or data in persistent storage. The Importer that you've
   *                   configured to use will resolve this to a location in the storage system.
   * @returns A promise that resolves to the parsed block.
   */
  getBlockFromPath(filePath: string): Promise<Block> {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`An absolute path is required. Got: ${filePath}.`);
    }
    filePath = path.resolve(filePath);

    let identifier: FileIdentifier = this.paths[filePath] || this.importer.identifier(null, filePath, this.configuration);
    return this.getBlock(identifier);
  }

  /**
   * Given a FileIdentifier that points to block data on storage, load the data and parse it
   * into a CSS Block. In most cases, you'll likely want to use getBlockFromPath() instead.
   *
   * If the block for the given identifier has already been loaded and parsed,
   * the cached data will be returned instead. If loading and parsing is already in progress,
   * the existing promise for that identifier will be returned.
   *
   * @param identifier - An identifier that points at a data file or blob in persistent storage.
   *                     These identifiers are created by the Importer that you've configured
   *                     to use.
   * @returns A promise that resolves to the parsed block.
   */
  getBlock(identifier: FileIdentifier): Promise<Block> {
    if (this.blocks[identifier]) {
      return Promise.resolve(this.blocks[identifier]);
    } else if (this.promises[identifier]) {
      return this.promises[identifier].catch(() => {
        // If we got an error last time, try again.
        // Also this makes sure that the error object gives a correct import stack trace.
        return this._getBlockPromise(identifier);
      });
    }
    return this._getBlockPromise(identifier);
  }

  /**
   * Make a promise to load and parse a CSS Block data file, add it to the cache,
   * and return it.
   *
   * @param identifier - An identifier that points at a data file or blob in persistent storage.
   * @returns A promise that resolves to the parsed block.
   */
  private _getBlockPromise(identifier: FileIdentifier): Promise<Block> {
    return this.promises[identifier] = this._getBlockPromiseAsync(identifier);
  }

  /**
   * An async method that loads and parses a CSS Block data file. We load the data here, using
   * the Importer, then defer to another method to actually parse the data file into a Block.
   *
   * @param identifier - An identifier that points at a data file or blob in persistent storage.
   * @returns A promise that resolves to the parsed block.
   */
  private async _getBlockPromiseAsync(identifier: FileIdentifier): Promise<Block> {
    try {
      let file = await this.importer.import(identifier, this.configuration);

      let block: Block;
      if (file.type === "ImportedCompiledCssFile") {
        block = await this._reconstituteCompiledCssSource(file);
      } else {
        block = await this._importAndPreprocessBlock(file);
      }

      debug(`Finalizing Block object for "${block.identifier}"`);

      // last check to make sure we don't return a new instance
      if (this.blocks[block.identifier]) {
        return this.blocks[block.identifier];
      }

      // Ensure this block name is unique.
      const uniqueName = this.getUniqueBlockName(block.name, block.identifier, file.type === "ImportedCompiledCssFile");
      if (uniqueName === null) {
        // For ImportedCompiledCssFiles, leave the name alone and add an error.
        block.addError(
          new CssBlockError(`Block uses a name that has already been used by ${this.blockNames[block.name]}`, {
            filename: block.identifier,
          }),
        );
        block.setName(block.name);
      } else {
        block.setName(uniqueName);
      }

      // Ensure the GUID is unique.
      const guidRegResult = this.registerGuid(block.guid);
      if (!guidRegResult) {
        block.addError(
            new CssBlockError("Block uses a GUID that has already been used! Check dependencies for conflicting GUIDs and/or increase the number of significant characters used to generate GUIDs.", {
              filename: block.identifier,
            },
          ),
        );
      }

      // if the block has any errors, surface them here unless we're in fault tolerant mode.
      this._surfaceBlockErrors(block);
      this.blocks[block.identifier] = block;
      return block;
    } catch (error) {
      if (this.preprocessQueue.activeJobCount > 0) {
        debug(`Block error. Currently there are ${this.preprocessQueue.activeJobCount} preprocessing jobs. waiting.`);
        await this.preprocessQueue.drain();
        debug(`Drain complete. Raising error.`);
        throw error;
      } else {
        debug(`Block error. There are no preprocessing jobs. raising.`);
        throw error;
      }
    }
  }

  /**
   * Depending on whether the blockFactory is fault tolerant or not, it either
   * surfaces the errors or swallows them and reexports the block interface
   * @param block the block to check for errors
   */
  private _surfaceBlockErrors(block: Block): Block {
    if (this.faultTolerant) {
      return block;
    } else {
      return block.assertValid();
    }
  }

  /**
   * Parse the file into a `Block`. Specifically, this method runs the data through any related
   * preprocessor (such as a SASS or LESS compiler), parses the CSS into an AST using PostCSS, then
   * hands the AST off to the Block parser to validate the CSS and transform it into the Block
   * class used by CSS Blocks.
   *
   * Notably, this method expects that any related file data has already been loaded from memory
   * using the Importer.
   *
   * @param file - The file information that has been previously imported by the Importer, for
   *               a single block identifier.
   * @returns A promise that resolves to a parsed block.
   **/
  private async _importAndPreprocessBlock(file: ImportedFile): Promise<Block> {
    // If the file identifier maps back to a real filename, ensure it is actually unique.
    let realFilename = this.importer.filesystemPath(file.identifier, this.configuration);
    if (realFilename) {
      if (this.paths[realFilename] && this.paths[realFilename] !== file.identifier) {
        throw new Error(`The same block file was returned with different identifiers: ${this.paths[realFilename]} and ${file.identifier}`);
      } else {
        this.paths[realFilename] = file.identifier;
      }
    }

    // Skip preprocessing if we can.
    if (this.blocks[file.identifier]) {
      debug(`Using pre-compiled Block for "${file.identifier}"`);
      return this.blocks[file.identifier];
    }

    // Preprocess the file.
    let filename: string = realFilename || this.importer.debugIdentifier(file.identifier, this.configuration);
    let preprocessor = this.preprocessor(file);

    debug(`Preprocessing "${filename}"`);
    let preprocessResult = await this.preprocessQueue.enqueue({
      preprocessor,
      filename,
      contents: file.contents,
    });

    debug(`Generating PostCSS AST for "${filename}"`);
    let sourceMap = sourceMapFromProcessedFile(preprocessResult);
    let content = preprocessResult.content;
    if (sourceMap) {
      content = annotateCssContentWithSourceMap(this.configuration, filename, content, sourceMap);
    }
    let root = await this.postcssImpl.parse(content, { from: filename });

    // Skip parsing if we can.
    if (this.blocks[file.identifier]) {
      return this.blocks[file.identifier];
    }
    debug(`Parsing Block object for "${filename}"`);
    let source: ParsedSource = {
      identifier: file.identifier,
      defaultName: file.defaultName,
      parseResult: root,
      originalSource: file.contents,
      originalSyntax: file.syntax,
      dependencies: preprocessResult.dependencies || [],
    };

    return this.parser.parseSource(source);
  }

  private async _reconstituteCompiledCssSource(file: ImportedCompiledCssFile): Promise<Block> {
    // Maybe we already have this block in cache?
    if (this.blocks[file.identifier]) {
      debug(`Using pre-compiled Block for "${file.identifier}"`);
      return this.blocks[file.identifier];
    }

    // Update definition data to use latest block syntax.
    file = upgradeDefinitionFileSyntax(file);

    // NOTE: No need to run preprocessor - we assume that Compiled CSS has already been preprocessed.
    // Parse the definition file into an AST
    const definitionAst = this.postcssImpl.parse(file.definitionContents);
    const dfnDebugIdentifier = this.importer.debugIdentifier(file.definitionIdentifier, this.configuration);

    // Parse the CSS contents into an AST
    const cssContentsAst = this.postcssImpl.parse(file.cssContents);
    const cssDebugIdentifier = this.importer.debugIdentifier(file.identifier, this.configuration);

    // Sanity check! Did we actually get contents for both ASTs?
    if (!definitionAst || !definitionAst.nodes) {
      throw new CssBlockError(`Unable to parse definition file into AST!`, {
        filename: dfnDebugIdentifier,
      });
    }

    if (!cssContentsAst || !cssContentsAst.nodes) {
      throw new CssBlockError(`Unable to parse CSS contents into AST!`, {
        filename: cssDebugIdentifier,
      });
    }

    // Construct a Block out of the definition file.
    const block = await this.parser.parseDefinitionSource(definitionAst, file.identifier, file.blockId, file.defaultName);

    // Merge the rules from the CSS contents into the Block.
    block.precompiledStylesheet = cssContentsAst;
    this._mergeCssRulesIntoDefinitionBlock(block, cssContentsAst, file);

    // And we're done!
    return block;
  }

  /**
   * Merges the CSS rules from a Compiled CSS file into its associated block. The block
   * will have been created previously from parsing the definition file using BlockParser.
   * @param block - The block that was generated from a definition file.
   * @param cssContentsAst - The parsed AST generated from the CSS file's contents.
   * @param file - The CompiledCSSFile that this block and CSS file was parsed from.
   */
  private _mergeCssRulesIntoDefinitionBlock(block: Block, cssContentsAst: postcss.Root, file: ImportedCompiledCssFile) {
    const styleNodesMap = block.presetClassesMap(true);
    cssContentsAst.walkRules(rule => {
      const parsedSelectors = parseSelector(rule);

      parsedSelectors.forEach(sel => {
        const keys = sel.key.nodes;
        const keyStyleNodes: Styles[] = [];
        let doProcess = true;

        // Check selector: do not process selectors with class names that
        // aren't from this block. (aka: resolution selectors)
        keys.forEach(key => {
          if (key.type === "class") {
            const foundStyleNode = styleNodesMap[key.value];
            if (!foundStyleNode) {
              doProcess = false;
              return;
            }
            keyStyleNodes.push(foundStyleNode);
          }
        });
        // If this node should be processed, add its declarations to each class
        // in the key selector (the last part of the selector).
        // We add the declarations so that later we can determine any conflicts
        // between the imported CSS and any app CSS that relies on it.
        if (doProcess) {
          keyStyleNodes.forEach(node => {
            node.rulesets.addRuleset(this.configuration, file.identifier, rule);
          });
        }
      });
    });
  }

  /**
   * Similar to getBlock(), this imports and parses a block data file. However, this
   * method parses a block relative to another block.
   *
   * @param fromIdentifier - The FileIdentifier that references the base location that the
   *                         import path is relative to.
   * @param importPath - The relative import path for the file to import.
   * @returns A promise that resolves to a parsed block.
   */
  getBlockRelative(fromIdentifier: FileIdentifier, importPath: string): Promise<Block> {
    let importer = this.importer;
    let fromPath = importer.debugIdentifier(fromIdentifier, this.configuration);
    let identifier = importer.identifier(fromIdentifier, importPath, this.configuration);
    return this.getBlock(identifier).catch((err: ErrorWithErrNum) => {
      if (err.code === "ENOENT") {
        err.message = `From ${fromPath}: ${err.message}`;
      }
      throw err;
    });
  }

  /**
   * Register a new block name with the BlockFactory.
   * @param name The new block name to register.
   * @param doNotOverride If true, will not attempt to provide a new block name if the given
   *                      name has already been registered.
   * @return The unique block name that is now registered with the BlockFactory, or null if
   *         the name has already been registered and should not be overridden.
   */
  getUniqueBlockName(name: string, identifier: string, doNotOverride = false): string | null {
    if (!this.blockNames[name]) {
      this.blockNames[name] = identifier;
      return name;
    }
    if (doNotOverride) {
      return null;
    }
    let i = 2;
    while (this.blockNames[`${name}-${i}`]) {
      i++;
    }
    name = `${name}-${i}`;
    this.blockNames[name] = identifier;
    return name;
  }

  preprocessor(file: ImportedFile): Preprocessor {
    let syntax = file.syntax;
    let firstPreprocessor: Preprocessor | undefined = this.preprocessors[syntax];
    let preprocessor: Preprocessor | null = null;
    if (firstPreprocessor) {
      if (syntax !== Syntax.css && this.preprocessors.css && !this.configuration.disablePreprocessChaining) {
        let cssProcessor = this.preprocessors.css;
        preprocessor = (fullPath: string, content: string, configuration: ResolvedConfiguration): Promise<ProcessedFile> => {
          return firstPreprocessor!(fullPath, content, configuration).then(result => {
            let content = result.content.toString();
            return cssProcessor(fullPath, content, configuration, sourceMapFromProcessedFile(result)).then(result2 => {
              return {
                content: result2.content,
                sourceMap: sourceMapFromProcessedFile(result2),
                dependencies: (result.dependencies || []).concat(result2.dependencies || []),
              };
            });
          });
        };
      } else {
        preprocessor = firstPreprocessor;
      }
    } else if (syntax !== Syntax.css) {
      throw new Error(`No preprocessor provided for ${syntaxName(syntax)}.`);
    } else {
      preprocessor = (_fullPath: string, content: string, _options: ResolvedConfiguration): Promise<ProcessedFile> => {
        return Promise.resolve({
          content: content,
        });
      };

    }
    return preprocessor;
  }

  /**
   * Registers a new GUID with the BlockFactory.
   * @param guid - The guid to register.
   * @param identifier  - A reference to the file this block was generated from, for error reporting.
   * @return True if registration is successful, false otherwise.
   */
  registerGuid(guid: string): boolean {
    if (this.guids.has(guid)) {
      return false;
    }
    this.guids.add(guid);
    return true;
  }
}

function sourceMapFromProcessedFile(result: ProcessedFile): RawSourceMap | string | undefined {
  let sourceMap: LegacyRawSourceMap | RawSourceMap | string | undefined = result.sourceMap;
  if (!sourceMap && !isString(result.content) && result.content.map) {
    sourceMap = result.content.map.toJSON();
  }
  if (typeof sourceMap === "object") {
    return adaptFromLegacySourceMap(sourceMap);
  } else {
    return sourceMap;
  }
}
