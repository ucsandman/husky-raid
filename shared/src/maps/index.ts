import type { GameMap } from '../map'
import { bastion } from './bastion'
import { gutter } from './gutter'
import { hairpin } from './hairpin'

export const MAPS: Record<string, GameMap> = { gutter, hairpin, bastion }
