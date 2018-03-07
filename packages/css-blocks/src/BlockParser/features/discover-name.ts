import * as postcss from "postcss";

import { BLOCK_NAME, CLASS_NAME_IDENT } from "../../BlockSyntax";
import { sourceLocation } from "../../SourceLocation";
import * as errors from "../../errors";

export async function discoverName(root: postcss.Root, defaultName: string, file: string): Promise<string> {

  // Eagerly fetch custom `block-name` from the root block rule.
  root.walkRules(":scope", (rule) => {
    rule.walkDecls(BLOCK_NAME, (decl) => {
      if (!CLASS_NAME_IDENT.test(decl.value)) {
        throw new errors.InvalidBlockSyntax(
          `Illegal block name. '${decl.value}' is not a legal CSS identifier.`,
          sourceLocation(file, decl),
        );
      }

      defaultName = decl.value;

    });
  });

  return defaultName;
}
