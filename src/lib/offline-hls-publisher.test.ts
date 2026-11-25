/** @jest-environment node */

import {
  getH264SlicePpsIds,
  hasH264Idr,
  parseAvcDecoderConfiguration,
  updateH264ParameterSets,
} from './offline-hls-publisher';

describe('H.264 packet helpers', () => {
  const avcC = Buffer.from([
    0x01, 0x42, 0x00, 0x1e, 0xff, 0xe1,
    0x00, 0x05, 0x67, 0x42, 0x00, 0x1e, 0x80,
    0x01, 0x00, 0x02, 0x68, 0xc0,
  ]);

  it('reads avcC SPS/PPS and detects an in-band SPS update with the same id', () => {
    const configuration = parseAvcDecoderConfiguration(avcC);
    const state = { sps: new Map(configuration.sps), pps: new Map(configuration.pps) };
    const updatedSps = Buffer.from([0x67, 0x4d, 0x00, 0x1e, 0x80]);
    const packet = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, updatedSps.length]),
      updatedSps,
      Buffer.from([0x00, 0x00, 0x00, 0x02, 0x65, 0xb8]),
    ]);

    expect(configuration.nalLengthSize).toBe(4);
    expect(updateH264ParameterSets(packet, configuration.nalLengthSize, state)).toBe(true);
    expect(state.sps.get(0)).toEqual(updatedSps);
  });

  it('reads the active PPS id from an IDR slice even when avcC already contains it', () => {
    const idrPacket = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x65, 0xb8]);
    expect(hasH264Idr(idrPacket, 4)).toBe(true);
    expect(getH264SlicePpsIds(idrPacket, 4)).toEqual([0]);
  });
});
