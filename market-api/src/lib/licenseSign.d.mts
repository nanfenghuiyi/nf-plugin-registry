export interface EntitlementPayload {
  pluginId: string;
  edition?: string;
  subject: string;
  issuedAt: number;
  exp: number | null;
  orderId: string;
}

export declare const LIC_HEADER: { alg: string; typ: string; v: number };

export declare function generateMarketLicenseKeyPair(): Promise<{
  publicKeyPem: string;
  privateKeyPem: string;
}>;

export declare function signEntitlement(
  payload: EntitlementPayload,
  privateKeyPem: string,
): Promise<string>;

export declare function verifyEntitlement(
  token: string,
  publicKeyPem: string,
  subject: string,
  now?: number,
): Promise<EntitlementPayload>;

export declare function b64urlEncode(buf: string | Uint8Array | ArrayBuffer): string;
export declare function b64urlDecode(str: string): Uint8Array;
