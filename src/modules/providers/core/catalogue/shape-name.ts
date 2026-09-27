import { NodeSizeDto } from '../../dto/node-size.dto';

/**
 * The catalogue names a shape (`cpx22`), while a client may pick it by the
 * provider's id for it (`109`): the name is what every later reader expects.
 */
export function shapeNameOf(
  nodeSize: string,
  sizes: Pick<NodeSizeDto, 'id' | 'name'>[],
): string {
  const size = sizes.find((s) => s.name === nodeSize || s.id === nodeSize);
  return size?.name || nodeSize;
}
