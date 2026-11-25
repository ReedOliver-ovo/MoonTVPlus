export interface AvcDecoderConfiguration {
  nalLengthSize: number;
  sps: Map<number, Buffer>;
  pps: Map<number, Buffer>;
}

export interface H264ParameterState {
  sps: Map<number, Buffer>;
  pps: Map<number, Buffer>;
}

function readUnsignedExpGolombAt(
  bytes: Buffer,
  startBit: number
): { value: number; nextBit: number } | undefined {
  let bitIndex = startBit;
  let leadingZeroBits = 0;

  while (bitIndex < bytes.length * 8) {
    const bit = (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    if (bit === 1) break;
    leadingZeroBits++;
  }

  if (leadingZeroBits > 31 || bitIndex + leadingZeroBits > bytes.length * 8) {
    return undefined;
  }

  let suffix = 0;
  for (let index = 0; index < leadingZeroBits; index++) {
    const bit = (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    suffix = (suffix << 1) | bit;
    bitIndex++;
  }
  return { value: 2 ** leadingZeroBits - 1 + suffix, nextBit: bitIndex };
}

function readUnsignedExpGolomb(bytes: Buffer, startBit: number): number | undefined {
  return readUnsignedExpGolombAt(bytes, startBit)?.value;
}

function rbspFromNal(nal: Buffer): Buffer {
  const output: number[] = [];
  let zeroCount = 0;
  for (let index = 1; index < nal.length; index++) {
    const byte = nal[index];
    if (zeroCount >= 2 && byte === 3) {
      zeroCount = 0;
      continue;
    }
    output.push(byte);
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  return Buffer.from(output);
}

function getParameterSetId(nal: Buffer): number | undefined {
  const rbsp = rbspFromNal(nal);
  const nalType = nal[0] & 0x1f;
  const startBit = nalType === 7 ? 24 : 0;
  return readUnsignedExpGolomb(rbsp, startBit);
}

function readNalUnits(packet: Buffer, nalLengthSize: number): Buffer[] {
  const nalUnits: Buffer[] = [];
  let offset = 0;
  while (offset + nalLengthSize <= packet.length) {
    const nalSize = packet.readUIntBE(offset, nalLengthSize);
    offset += nalLengthSize;
    if (nalSize <= 0 || offset + nalSize > packet.length) {
      throw new Error('H.264 视频包的 NAL 长度无效');
    }
    nalUnits.push(packet.subarray(offset, offset + nalSize));
    offset += nalSize;
  }
  if (offset !== packet.length || nalUnits.length === 0) {
    throw new Error('H.264 视频包格式无效');
  }
  return nalUnits;
}

export function parseAvcDecoderConfiguration(data: Buffer): AvcDecoderConfiguration {
  if (data.length < 7 || data[0] !== 1) {
    throw new Error('MP4 缺少有效的 H.264 avcC 配置');
  }

  const nalLengthSize = (data[4] & 0x03) + 1;
  let offset = 6;
  const sps = new Map<number, Buffer>();
  const pps = new Map<number, Buffer>();
  const spsCount = data[5] & 0x1f;

  const readParameterSets = (count: number, destination: Map<number, Buffer>) => {
    for (let index = 0; index < count; index++) {
      if (offset + 2 > data.length) throw new Error('MP4 的 H.264 参数集不完整');
      const size = data.readUInt16BE(offset);
      offset += 2;
      if (size <= 0 || offset + size > data.length) {
        throw new Error('MP4 的 H.264 参数集长度无效');
      }
      const nal = Buffer.from(data.subarray(offset, offset + size));
      offset += size;
      const id = getParameterSetId(nal);
      if (id !== undefined) destination.set(id, nal);
    }
  };

  readParameterSets(spsCount, sps);
  if (offset >= data.length) throw new Error('MP4 缺少 H.264 PPS 参数集');
  const ppsCount = data[offset++];
  readParameterSets(ppsCount, pps);

  if (sps.size === 0 || pps.size === 0) {
    throw new Error('MP4 缺少可识别的 H.264 SPS 或 PPS 参数集');
  }
  return { nalLengthSize, sps, pps };
}

export function updateH264ParameterSets(
  packet: Buffer,
  nalLengthSize: number,
  state: H264ParameterState
): boolean {
  let changed = false;
  for (const nal of readNalUnits(packet, nalLengthSize)) {
    const nalType = nal[0] & 0x1f;
    if (nalType !== 7 && nalType !== 8) continue;
    const id = getParameterSetId(nal);
    if (id === undefined) continue;
    const destination = nalType === 7 ? state.sps : state.pps;
    const previous = destination.get(id);
    if (!previous || !previous.equals(nal)) changed = true;
    destination.set(id, Buffer.from(nal));
  }
  return changed;
}

export function getH264SlicePpsIds(packet: Buffer, nalLengthSize: number): number[] {
  const ppsIds: number[] = [];
  for (const nal of readNalUnits(packet, nalLengthSize)) {
    const nalType = nal[0] & 0x1f;
    if (nalType !== 1 && nalType !== 5) continue;
    const rbsp = rbspFromNal(nal);
    const firstMacroblock = readUnsignedExpGolombAt(rbsp, 0);
    if (!firstMacroblock) continue;
    const sliceType = readUnsignedExpGolombAt(rbsp, firstMacroblock.nextBit);
    if (!sliceType) continue;
    const ppsId = readUnsignedExpGolombAt(rbsp, sliceType.nextBit);
    if (ppsId) ppsIds.push(ppsId.value);
  }
  return ppsIds;
}

export function hasH264Idr(packet: Buffer, nalLengthSize: number): boolean {
  return readNalUnits(packet, nalLengthSize).some((nal) => (nal[0] & 0x1f) === 5);
}
