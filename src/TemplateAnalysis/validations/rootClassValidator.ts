import { BlockObject, Block, BlockClass } from "../../Block";

/**
 * Prevent BlockClasses from being applied to the same element is their Root.
 * @param correlations The correlations object for a given element.
 * @param err Error callback.
 */
export default function rootClassValidator(correlations: Set<BlockObject>[], err: (str: string) => void): void {
  correlations.forEach(( correlation ) => {
    let rootBlocks: Set<Block> = new Set();
    correlation.forEach(( blockObj ) => blockObj instanceof Block && rootBlocks.add(blockObj) );
    correlation.forEach(( blockObj ) => {
      if ( (blockObj instanceof BlockClass) && rootBlocks.has(blockObj.block) ) {
        err(`Cannot put block classes on the block's root element`);
      }
    });
  });
}
