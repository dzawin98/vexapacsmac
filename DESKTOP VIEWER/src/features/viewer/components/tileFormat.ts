export const tileFormatOptions = [
  { id: 'auto', label: 'Auto' },
  { id: '1', label: '1-Up' },
  { id: '2', label: '2-Up' },
  { id: '4', label: '4-Up' },
  { id: '6', label: '6-Up' },
  { id: '9', label: '9-Up' },
  { id: '12', label: '12-Up' },
  { id: '20', label: '20-Up' },
] as const

export type TileFormat = (typeof tileFormatOptions)[number]['id']

export function getTileFormatLabel(format: TileFormat) {
  return tileFormatOptions.find((option) => option.id === format)?.label ?? '1-Up'
}

export function isTileFormatActive(format: TileFormat) {
  return format !== '1'
}
