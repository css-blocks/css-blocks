import { postcss } from "opticss";

import { BLOCK_EXPORT, CLASS_NAME_IDENT, DEFAULT_EXPORT } from "../../BlockSyntax";
import { Block } from "../../BlockTree";
import * as errors from "../../errors";
import { sourceLocation } from "../../SourceLocation";

import { BlockFactory } from "../index";
import { parseBlockNames } from "../utils/blockNamesParser";

const FROM_EXPR = /\s+from\s+/;

/**
 * Strip matching quotes from the beginning and end of a string
 * @param str String to strip quotes from
 * @return Result
 */
function stripQuotes(str: string): string {
  return str.replace(/^(["'])(.+)\1$/, "$2");
}

/**
 * Resolve all block references for a given block.
 * @param block Block to resolve references for
 * @return Promise that resolves when all references have been loaded.
 */
export async function exportBlocks(block: Block, factory: BlockFactory, file: string): Promise<Block> {

  let root: postcss.Root | undefined = block.stylesheet;
  const exportPromises: Promise<void>[] = [];
  const remoteNames: Set<string> = new Set();

  if (!root) {
    throw new errors.InvalidBlockSyntax(`Error finding PostCSS root for block ${block.name}`);
  }

  // Blocks will always export themselves as the default export.
  block.addBlockExport(DEFAULT_EXPORT, block);

  // For each `@block` expression, read in the block file, parse and
  // push to block references Promise array.
  root.walkAtRules(BLOCK_EXPORT, async (atRule: postcss.AtRule) => {
    let exports = atRule.params;

    let [exportList = "", blockPath = ""] = exports.split(FROM_EXPR);
    blockPath = stripQuotes(blockPath);

    if (!exportList) {
      throw new errors.InvalidBlockSyntax(
        `Malformed block export: \`@export ${atRule.params}\``,
        sourceLocation(file, atRule),
      );
    }

    // Import file, then parse file, then save block reference.
    let srcBlockPromise: Promise<Block> = Promise.resolve(block);
    if (blockPath) {
      srcBlockPromise = factory.getBlockRelative(block.identifier, blockPath);
    }

    // Validate our imported block name is a valid CSS identifier.
    const blockNames = parseBlockNames(exportList, !!blockPath);
    const exportPromise = srcBlockPromise.then((srcBlock) => {
      for (let remoteName of Object.keys(blockNames)) {
        if (remoteNames.has(remoteName)) {
        throw new errors.InvalidBlockSyntax(
          `Can not have duplicate Block export of same name: "${remoteName}".`,
          sourceLocation(file, atRule),
          );
        }
        let localName = blockNames[remoteName];
        console.log(remoteName, localName, block.identifier);
        if (!CLASS_NAME_IDENT.test(localName)) {
          throw new errors.InvalidBlockSyntax(
            `Illegal block name in export. "${localName}" is not a legal CSS identifier.`,
            sourceLocation(file, atRule),
          );
        }
        if (!CLASS_NAME_IDENT.test(remoteName)) {
          throw new errors.InvalidBlockSyntax(
            `Illegal block name in import. "${remoteName}" is not a legal CSS identifier.`,
            sourceLocation(file, atRule),
          );
        }
        if (localName === DEFAULT_EXPORT && remoteName === DEFAULT_EXPORT) {
          throw new errors.InvalidBlockSyntax(
            `Unnecessary re-export of default Block.`,
            sourceLocation(file, atRule),
          );
        }
        if (remoteName === DEFAULT_EXPORT) {
          throw new errors.InvalidBlockSyntax(
            `Can not export "${localName}" as reserved word "${DEFAULT_EXPORT}"`,
            sourceLocation(file, atRule),
          );
        }

        let referencedBlock = srcBlock.getReferencedBlock(localName);
        if (!referencedBlock) {
          throw new errors.InvalidBlockSyntax(
            `Can not export Block "${localName}". No Block named "${localName}" in "${file}".`,
            sourceLocation(file, atRule),
          );
        }

        // Save exported blocks
        block.addBlockExport(remoteName, referencedBlock);

      }
    });

    exportPromises.push(exportPromise);

  });

  // After all export promises have resolved, resolve the decorated Block.
  return Promise.all(exportPromises).then(() => block);
}
