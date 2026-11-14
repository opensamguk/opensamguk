"""Normalize and render a generated map model for D-095 comparison."""
import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--rotate', type=float, default=0, help='Degrees around the vertical axis')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.source))
    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == 'MESH']
    if not meshes:
        raise ValueError('No mesh in GLB')
    root = bpy.data.objects.new('map-model', None)
    scene.collection.objects.link(root)
    for obj in scene_roots(scene, root):
        obj.parent = root
    root.rotation_euler.z = args.rotate * 3.141592653589793 / 180
    bpy.context.view_layer.update()
    vertices = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    minimum = Vector(map(min, zip(*vertices)))
    maximum = Vector(map(max, zip(*vertices)))
    side = max((maximum - minimum).x, (maximum - minimum).y)
    if side <= 0:
        raise ValueError('Empty model footprint')
    centre = (minimum + maximum) / 2
    root.scale = (1 / side,) * 3
    root.location = (-centre.x / side, -centre.y / side, -minimum.z / side)
    bpy.context.view_layer.update()
    args.output.mkdir(parents=True, exist_ok=True)
    for lod, ratio in enumerate((1, .28, .075)):
        modifiers = []
        if ratio < 1:
            for obj in meshes:
                modifier = obj.modifiers.new('LOD', 'DECIMATE')
                modifier.ratio = ratio
                modifiers.append((obj, modifier))
        bpy.ops.export_scene.gltf(filepath=str(args.output / f'{args.source.stem}-lod{lod}.glb'),
                                  export_format='GLB', export_apply=True)
        for obj, modifier in modifiers:
            obj.modifiers.remove(modifier)

    bpy.ops.object.camera_add(location=(0, -1.6, 1.73))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, .13)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 1.83
    scene.camera = camera
    scene.world = bpy.data.worlds.new('Preview')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.21, .24, .27, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .48
    for position, power, color in [((-3, 1, 5), 3.2, (1, .88, .72)), ((2, -3, 3), .7, (.74, .83, 1))]:
        bpy.ops.object.light_add(type='SUN', location=position)
        lamp = bpy.context.object
        lamp.rotation_euler = (-lamp.location).to_track_quat('-Z', 'Y').to_euler()
        lamp.data.energy, lamp.data.color = power, color
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 12
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(args.output / (args.source.stem + '-1920x1080.png'))
    bpy.ops.render.render(write_still=True)


def scene_roots(scene, root):
    return [obj for obj in scene.objects if obj != root and obj.parent is None]


if __name__ == '__main__':
    main()
