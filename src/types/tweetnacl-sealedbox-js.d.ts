declare module "tweetnacl-sealedbox-js" {
  const sealedBox: {
    overheadLength: number;
    seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
    open(ciphertext: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
  };
  export default sealedBox;
}
