/** Prints computeSecretHash([0]): the constant secret hash the portal uses for register_batch. */
import { Fr } from "@aztec-labs/aztec.js/fields";
import { computeSecretHash } from "@aztec-labs/stdlib/hash";

console.log((await computeSecretHash(new Fr(0))).toString());
