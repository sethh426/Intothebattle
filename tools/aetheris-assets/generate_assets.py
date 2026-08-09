"""Generate Aetheris structure GLBs with Blender 4.5 LTS.

The output is intentionally procedural and deterministic. Blender is used as the
authoring/export DCC so runtime code receives clean, Y-up, named glTF assets rather
than rebuilding visible landmarks from browser primitives.
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import bpy
from mathutils import Vector


BIOMES = [
    "frozen-crown",
    "thunder-highlands",
    "whispering-desert",
    "ancient-jungle",
    "emerald-wilds",
    "liquid-blu-metal-sea",
    "molten-wastes",
    "toxic-expanse",
    "crystal-basin",
    "void-scar",
]

PALETTES = {
    "frozen-crown": ("#667887", "#dff8ff", "#55d8ff", "#152330"),
    "thunder-highlands": ("#30324f", "#8e98b9", "#b7c7ff", "#14162b"),
    "whispering-desert": ("#765035", "#c8894f", "#ffd15c", "#332318"),
    "ancient-jungle": ("#344b2f", "#6b7540", "#66ff8d", "#201b14"),
    "emerald-wilds": ("#355836", "#76924e", "#b7ff82", "#1b2116"),
    "liquid-blu-metal-sea": ("#294956", "#8aa7b2", "#39e4ff", "#10252e"),
    "molten-wastes": ("#4a302b", "#82605a", "#ff7a24", "#1e1010"),
    "toxic-expanse": ("#3f4932", "#738060", "#b6ff36", "#172014"),
    "crystal-basin": ("#31566b", "#86a9b7", "#8af6ff", "#152537"),
    "void-scar": ("#21172c", "#5b4770", "#c46bff", "#090611"),
}


@dataclass
class MaterialSet:
    stone: bpy.types.Material
    trim: bpy.types.Material
    accent: bpy.types.Material
    dark: bpy.types.Material
    organic: bpy.types.Material
    glow: bpy.types.Material


def hex_rgba(value: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    value = value.lstrip("#")
    rgb = tuple(int(value[index:index + 2], 16) / 255.0 for index in (0, 2, 4))
    return (*rgb, alpha)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(datablocks):
            datablocks.remove(block)


def material(
    name: str,
    color: str,
    roughness: float,
    metallic: float = 0.0,
    emission: str | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = hex_rgba(color)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        strength_input = bsdf.inputs.get("Emission Strength")
        if emission_input:
            emission_input.default_value = hex_rgba(emission)
        if strength_input:
            strength_input.default_value = emission_strength
    return mat


def make_materials(biome_id: str) -> MaterialSet:
    stone, trim, accent, dark = PALETTES[biome_id]
    organic_color = "#3a2b20" if biome_id in ("ancient-jungle", "emerald-wilds") else stone
    return MaterialSet(
        stone=material("STONE", stone, 0.72, 0.08),
        trim=material("TRIM", trim, 0.45, 0.28),
        accent=material("CRYSTAL", accent, 0.2, 0.24, accent, 1.25),
        dark=material("DARK", dark, 0.82, 0.08),
        organic=material("ORGANIC", organic_color, 0.88, 0.02),
        glow=material("EMISSIVE", accent, 0.24, 0.12, accent, 3.5),
    )


def parent_to(obj: bpy.types.Object, parent: bpy.types.Object | None) -> bpy.types.Object:
    if parent:
        obj.parent = parent
    return obj


def apply_transform(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def add_bevel(obj: bpy.types.Object, amount: float, segments: int = 2) -> None:
    if amount <= 0:
        return
    modifier = obj.modifiers.new("Edge wear", "BEVEL")
    modifier.width = amount
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def cube(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    rotation: tuple[float, float, float] = (0, 0, 0),
    bevel: float = 0.02,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (scale[0] / 2, scale[1] / 2, scale[2] / 2)
    apply_transform(obj)
    add_bevel(obj, bevel)
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    vertices: int = 12,
    radius_top: float | None = None,
    rotation: tuple[float, float, float] = (0, 0, 0),
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=max(6, vertices),
        radius1=radius,
        radius2=radius if radius_top is None else radius_top,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    if bevel > 0:
        add_bevel(obj, bevel)
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def torus(
    name: str,
    location: tuple[float, float, float],
    major_radius: float,
    minor_radius: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    rotation: tuple[float, float, float] = (0, 0, 0),
    segments: int = 24,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=max(12, segments),
        minor_segments=6,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def ico(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    subdivisions: int = 1,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=max(1, subdivisions),
        radius=1,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_transform(obj)
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def crystal(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    height: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    sides: int = 6,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    lower = -height * 0.48
    shoulder = height * 0.25
    tip = height * 0.52
    vertices = [(0, 0, tip)]
    for z, factor in ((shoulder, 1.0), (lower, 0.72)):
        for index in range(sides):
            angle = index / sides * math.tau
            vertices.append((math.cos(angle) * radius * factor, math.sin(angle) * radius * factor, z))
    vertices.append((0, 0, lower - height * 0.12))
    top_tip = 0
    bottom_tip = len(vertices) - 1
    faces = []
    for index in range(sides):
        nxt = (index + 1) % sides
        top_a = 1 + index
        top_b = 1 + nxt
        low_a = 1 + sides + index
        low_b = 1 + sides + nxt
        faces.extend([
            (top_tip, top_a, top_b),
            (top_a, low_a, low_b, top_b),
            (bottom_tip, low_b, low_a),
        ])
    mesh = bpy.data.meshes.new(f"{name}_MESH")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rotation
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def curve_path(
    name: str,
    points: list[tuple[float, float, float]],
    radius: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object | None = None,
    resolution: int = 2,
) -> bpy.types.Object:
    curve_data = bpy.data.curves.new(f"{name}_CURVE", "CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = resolution
    curve_data.bevel_depth = radius
    curve_data.bevel_resolution = 1
    spline = curve_data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def irregular_socket(
    name: str,
    radius: float,
    height: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object | None,
    rng: random.Random,
    segments: int = 16,
) -> bpy.types.Object:
    top = []
    bottom = []
    for index in range(segments):
        angle = index / segments * math.tau
        r = radius * (0.82 + rng.random() * 0.24)
        top.append((math.cos(angle) * r, math.sin(angle) * r, height))
        bottom.append((math.cos(angle) * r * 1.08, math.sin(angle) * r * 1.08, 0))
    vertices = top + bottom + [(0, 0, height)]
    faces = []
    center = len(vertices) - 1
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((center, index, nxt))
        faces.append((index, segments + index, segments + nxt, nxt))
    mesh = bpy.data.meshes.new(f"{name}_MESH")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return parent_to(obj, parent)


def mountain_mesh(
    name: str,
    mat: bpy.types.Material,
    parent: bpy.types.Object,
    rng: random.Random,
    detail: int,
) -> bpy.types.Object:
    segments = 18 if detail == 0 else 14 if detail == 1 else 10
    rings = [
        (0.04, 0.78, (-0.02, 0.01)),
        (0.22, 0.62, (0.05, -0.03)),
        (0.46, 0.46, (-0.02, 0.06)),
        (0.67, 0.29, (0.03, 0.01)),
        (0.72, 0.24, (0.03, 0.01)),
    ]
    vertices = []
    for ring_index, (z, radius, offset) in enumerate(rings):
        for index in range(segments):
            angle = index / segments * math.tau
            jag = 0.84 + rng.random() * (0.26 if ring_index < 3 else 0.12)
            vertices.append((
                offset[0] + math.cos(angle) * radius * jag,
                offset[1] + math.sin(angle) * radius * jag,
                z + (rng.random() - 0.5) * 0.035,
            ))
    faces = []
    for ring_index in range(len(rings) - 1):
        for index in range(segments):
            nxt = (index + 1) % segments
            a = ring_index * segments + index
            b = ring_index * segments + nxt
            c = (ring_index + 1) * segments + nxt
            d = (ring_index + 1) * segments + index
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(f"{name}_MESH")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    parent_to(obj, parent)
    return obj


def empty(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    return obj


def ring_wall(
    parent: bpy.types.Object,
    mat: bpy.types.Material,
    radius: float,
    count: int,
    z: float,
    height: float,
    thickness: float,
    prefix: str,
) -> None:
    for index in range(count):
        angle = index / count * math.tau
        width = math.tau * radius / count * 0.9
        cube(
            f"{prefix}_{index:02}",
            (math.cos(angle) * radius, math.sin(angle) * radius, z),
            (width, thickness, height),
            mat,
            parent,
            rotation=(0, 0, angle + math.pi / 2),
            bevel=0.012,
        )


def stairs(
    parent: bpy.types.Object,
    mat: bpy.types.Material,
    start: tuple[float, float, float],
    direction: tuple[float, float],
    count: int,
    width: float,
    rise: float,
    run: float,
    prefix: str,
) -> None:
    for index in range(count):
        cube(
            f"{prefix}_{index:02}",
            (
                start[0] + direction[0] * run * index,
                start[1] + direction[1] * run * index,
                start[2] + rise * index / 2,
            ),
            (width, run, rise * (index + 1)),
            mat,
            parent,
            bevel=0.006,
        )


def build_frozen(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("STONE_TERRAIN_SOCKET", 0.84, 0.085, mats.dark, root, rng, 20 - lod * 4)
    ring_wall(root, mats.stone, 0.57, 12 - lod * 2, 0.18, 0.24, 0.08, "STONE_GLACIER_WALL")
    towers = 6 if lod < 2 else 4
    for index in range(towers):
        angle = index / towers * math.tau + math.pi / 6
        x, y = math.cos(angle) * 0.53, math.sin(angle) * 0.53
        cylinder(f"STONE_ICE_TOWER_{index}", (x, y, 0.33), 0.105, 0.5, mats.stone, root, 10, 0.082)
        crystal(f"CRYSTAL_TOWER_CROWN_{index}", (x, y, 0.66), 0.105, 0.28, mats.accent, root)
    cylinder("STONE_CENTRAL_KEEP", (0, 0.03, 0.42), 0.27, 0.68, mats.stone, root, 8, 0.2, bevel=0.025)
    cylinder("TRIM_KEEP_CROWN", (0, 0.03, 0.75), 0.22, 0.12, mats.trim, root, 8, 0.16)
    for index in range(4):
        angle = index / 4 * math.tau + math.pi / 4
        crystal(
            f"CRYSTAL_BUTTRESS_{index}",
            (math.cos(angle) * 0.32, math.sin(angle) * 0.32 + 0.03, 0.34),
            0.12,
            0.56,
            mats.trim,
            root,
            rotation=(0.18 * math.sin(angle), 0.2 * math.cos(angle), angle),
        )
    cube("STONE_BRIDGE", (0, -0.72, 0.13), (0.21, 0.68, 0.09), mats.stone, root)
    for side in (-1, 1):
        cube(f"TRIM_BRIDGE_RAIL_{side}", (side * 0.105, -0.72, 0.19), (0.028, 0.68, 0.11), mats.trim, root, bevel=0.006)
    cube("DARK_GATE_MOUTH", (0, -0.535, 0.26), (0.13, 0.035, 0.2), mats.dark, root, bevel=0.012)
    crystal("FX_CORE_BEACON", (0, 0.03, 0.98), 0.12, 0.34, mats.glow, root)


def build_thunder(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("STONE_TERRAIN_SOCKET", 0.86, 0.09, mats.dark, root, rng)
    cylinder("STONE_OBSERVATORY_LOWER", (0, 0.04, 0.25), 0.39, 0.36, mats.stone, root, 10, 0.32, bevel=0.025)
    cylinder("TRIM_OBSERVATORY_GALLERY", (0, 0.04, 0.44), 0.3, 0.1, mats.trim, root, 12, 0.25)
    cylinder("STONE_OBSERVATORY_DOME", (0, 0.04, 0.58), 0.22, 0.27, mats.stone, root, 12, 0.1)
    cube("DARK_SKY_APERTURE", (0, -0.19, 0.59), (0.17, 0.035, 0.17), mats.dark, root, rotation=(0.1, 0, 0))
    conductor_count = 4 if lod < 2 else 3
    for index in range(conductor_count):
        angle = index / conductor_count * math.tau + 0.36
        x, y = math.cos(angle) * 0.54, math.sin(angle) * 0.54
        cylinder(f"STONE_CONDUCTOR_BASE_{index}", (x, y, 0.22), 0.11, 0.3, mats.stone, root, 8, 0.075)
        cylinder(f"METAL_CONDUCTOR_{index}", (x, y, 0.55), 0.055, 0.58, mats.trim, root, 8, 0.024)
        crystal(f"EMISSIVE_CONDUCTOR_TIP_{index}", (x, y, 0.91), 0.075, 0.19, mats.glow, root)
        curve_path(
            f"EMISSIVE_LIGHTNING_RAIL_{index}",
            [(x, y, 0.54), (x * 0.58, y * 0.58, 0.76), (0, 0.04, 0.77)],
            0.009,
            mats.accent,
            root,
        )
    torus("FX_RING_PRIMARY", (0, 0.04, 0.77), 0.22, 0.018, mats.trim, root, rotation=(math.pi / 2, 0.18, 0.08))
    if lod < 2:
        torus("FX_RING_SECONDARY", (0, 0.04, 0.77), 0.15, 0.01, mats.accent, root, rotation=(math.pi / 2, -0.22, 0.44))
    crystal("FX_CORE", (0, 0.04, 0.79), 0.105, 0.29, mats.glow, root)


def build_desert(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("STONE_TERRAIN_SOCKET", 0.82, 0.05, mats.dark, root, rng)
    ico("STONE_TITAN_TORSO", (0.02, 0.1, 0.28), (0.36, 0.25, 0.29), mats.stone, root, 2 if lod == 0 else 1)
    head = ico("STONE_TITAN_HEAD", (0.02, 0.08, 0.62), (0.23, 0.19, 0.26), mats.stone, root, 2 if lod == 0 else 1)
    head.rotation_euler = (0.12, -0.08, -0.08)
    for side in (-1, 1):
        ico(f"STONE_BURIED_HAND_{side}", (side * 0.45, -0.04, 0.17), (0.2, 0.12, 0.13), mats.stone, root)
        cube(f"STONE_GATE_PILLAR_{side}", (side * 0.48, 0.28, 0.37), (0.15, 0.16, 0.62), mats.trim, root)
    curve_path(
        "STONE_TITAN_GATE_ARCH",
        [(-0.48, 0.28, 0.68), (0, 0.28, 0.97), (0.48, 0.28, 0.68)],
        0.075,
        mats.trim,
        root,
    )
    cube("DARK_TITAN_FACE", (0, -0.105, 0.63), (0.18, 0.025, 0.14), mats.dark, root, rotation=(0.1, 0, 0))
    for side in (-1, 1):
        crystal(f"EMISSIVE_TITAN_EYE_{side}", (side * 0.065, -0.126, 0.67), 0.02, 0.045, mats.glow, root)
    if lod < 2:
        for index in range(5):
            cube(
                f"STONE_BROKEN_COLUMN_{index}",
                (-0.62 + index * 0.3, 0.52 + (index % 2) * 0.08, 0.18 + (index % 3) * 0.04),
                (0.07, 0.07, 0.28 + (index % 2) * 0.12),
                mats.trim,
                root,
                rotation=(0.1 * (index % 2), 0.08 * index, 0.08 * (index - 2)),
            )


def add_tree_structure(
    root: bpy.types.Object,
    mats: MaterialSet,
    lod: int,
    rng: random.Random,
    world_tree: bool,
) -> None:
    base_radius = 0.9 if world_tree else 0.82
    irregular_socket("STONE_TERRAIN_SOCKET", base_radius, 0.085, mats.dark, root, rng)
    cylinder("ORGANIC_TRUNK_LOWER", (0, 0, 0.38), 0.22 if world_tree else 0.19, 0.68, mats.organic, root, 10, 0.15)
    cylinder("ORGANIC_TRUNK_UPPER", (0.02, 0, 0.76), 0.145 if world_tree else 0.125, 0.52, mats.organic, root, 9, 0.08, rotation=(0.02, 0.08, -0.04))
    root_count = 8 if lod == 0 else 6 if lod == 1 else 4
    for index in range(root_count):
        angle = index / root_count * math.tau + rng.random() * 0.15
        curve_path(
            f"ORGANIC_BUTTRESS_ROOT_{index}",
            [
                (0, 0, 0.3),
                (math.cos(angle) * 0.35, math.sin(angle) * 0.35, 0.14),
                (math.cos(angle) * 0.78, math.sin(angle) * 0.78, 0.045),
            ],
            0.07 if world_tree else 0.055,
            mats.organic,
            root,
        )
    branch_count = 7 if lod == 0 else 5 if lod == 1 else 4
    for index in range(branch_count):
        angle = index / branch_count * math.tau + 0.28
        reach = (0.64 if world_tree else 0.54) * (0.85 + (index % 3) * 0.09)
        end = (math.cos(angle) * reach, math.sin(angle) * reach, 0.9 + (index % 3) * 0.09)
        curve_path(
            f"FX_FOLIAGE_BRANCH_{index}",
            [(0.01, 0, 0.69), (end[0] * 0.5, end[1] * 0.5, 0.88), end],
            0.05,
            mats.organic,
            root,
        )
        leaf_count = 3 if lod == 0 else 2
        for leaf_index in range(leaf_count):
            spread = (leaf_index - (leaf_count - 1) / 2) * 0.11
            crystal(
                f"FX_FOLIAGE_BLADE_{index}_{leaf_index}",
                (
                    end[0] + math.cos(angle + math.pi / 2) * spread,
                    end[1] + math.sin(angle + math.pi / 2) * spread,
                    end[2] + (leaf_index % 2) * 0.035,
                ),
                0.085 if world_tree else 0.072,
                0.3 if world_tree else 0.25,
                mats.accent,
                root,
                sides=5,
                rotation=(0.42, 0.15, angle),
            )
    cylinder("STONE_TEMPLE_TERRACE_LOWER", (0, 0, 0.18), 0.43, 0.14, mats.stone, root, 10, 0.37)
    cylinder("TRIM_TEMPLE_TERRACE_UPPER", (0, 0, 0.3), 0.31, 0.09, mats.trim, root, 10, 0.27)
    stairs(root, mats.stone, (0, -0.61, 0.055), (0, 1), 7 if lod < 2 else 5, 0.27, 0.025, 0.07, "STONE_TEMPLE_STEP")
    for index in range(4 if lod < 2 else 2):
        angle = index / 4 * math.tau + math.pi / 4
        x, y = math.cos(angle) * 0.48, math.sin(angle) * 0.48
        cylinder(f"STONE_ROOT_SHRINE_{index}", (x, y, 0.18), 0.09, 0.24, mats.stone, root, 7, 0.065)
        crystal(f"EMISSIVE_ROOT_LANTERN_{index}", (x, y, 0.35), 0.034, 0.09, mats.glow, root)
    platform_count = 3 if world_tree and lod < 2 else 2
    for index in range(platform_count):
        angle = index / max(platform_count, 1) * math.tau + 0.2
        x, y = math.cos(angle) * 0.29, math.sin(angle) * 0.29
        platform_z = 0.62 + index * 0.12
        cylinder(f"STONE_CANOPY_PLATFORM_{index}", (x, y, platform_z), 0.14, 0.055, mats.trim, root, 9)
        curve_path(
            f"TRIM_CANOPY_BRIDGE_{index}",
            [(0, 0, platform_z), (x * 0.5, y * 0.5, platform_z + 0.03), (x, y, platform_z)],
            0.026,
            mats.trim,
            root,
        )
        crystal(f"EMISSIVE_TREE_LANTERN_{index}", (x, y, platform_z + 0.11), 0.035, 0.09, mats.glow, root)


def build_magnetic(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("STONE_TERRAIN_SOCKET", 0.9, 0.075, mats.dark, root, rng)
    cube("METAL_FORGE_SPINE", (0, 0.12, 0.2), (0.38, 0.72, 0.24), mats.trim, root, bevel=0.035)
    cube("DARK_HARBOR_INLET", (0, -0.3, 0.16), (0.18, 0.36, 0.08), mats.dark, root, bevel=0.018)
    for side in (-1, 1):
        cube(f"METAL_HARBOR_PIER_{side}", (side * 0.28, -0.22, 0.13), (0.16, 0.68, 0.13), mats.stone, root, rotation=(0, 0, side * 0.08), bevel=0.025)
        cube(f"TRIM_HARBOR_CRANE_ARM_{side}", (side * 0.4, -0.14, 0.48), (0.08, 0.42, 0.08), mats.trim, root, rotation=(0, side * 0.1, side * 0.12), bevel=0.012)
    cylinder("METAL_FORGE_HEART", (0, 0.18, 0.44), 0.22, 0.49, mats.stone, root, 10, 0.15, bevel=0.02)
    pylons = 4 if lod < 2 else 3
    for index in range(pylons):
        x = (-0.5 if index % 2 == 0 else 0.5)
        y = (-0.28 if index < 2 else 0.36)
        cylinder(f"METAL_MAGNETIC_PYLON_{index}", (x, y, 0.42), 0.075, 0.64, mats.stone, root, 8, 0.04)
        crystal(f"EMISSIVE_PYLON_CORE_{index}", (x, y, 0.79), 0.057, 0.16, mats.glow, root)
    torus("FX_RING_PRIMARY", (0, 0.18, 0.72), 0.2, 0.025, mats.trim, root, rotation=(math.pi / 2, 0.1, 0.1), segments=24)
    if lod < 2:
        torus("FX_RING_SECONDARY", (0, 0.18, 0.72), 0.13, 0.012, mats.accent, root, rotation=(math.pi / 2, -0.22, 0.4))
    ico("FX_CORE", (0, 0.18, 0.72), (0.12, 0.12, 0.17), mats.glow, root, 2)
    for index in range(3 if lod < 2 else 2):
        x = (index - 1) * 0.14
        curve_path(
            f"EMISSIVE_LIQUID_METAL_FALL_{index}",
            [(x, -0.19, 0.37), (x * 1.25, -0.31, 0.22), (x * 1.5, -0.43, 0.07)],
            0.018,
            mats.glow,
            root,
        )


def build_molten(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("DARK_TERRAIN_SOCKET", 0.94, 0.075, mats.dark, root, rng)
    mountain_mesh("STONE_ASYMMETRIC_CALDERA", mats.stone, root, rng, lod)
    for index in range(8 if lod < 2 else 6):
        angle = index / 9 * math.tau + 0.18
        radius = 0.24 + (index % 3) * 0.025
        ico(
            f"DARK_JAGGED_CRATER_RIM_{index}",
            (0.03 + math.cos(angle) * radius, 0.01 + math.sin(angle) * radius, 0.72 + (index % 2) * 0.025),
            (0.11, 0.08, 0.12 + (index % 3) * 0.035),
            mats.dark,
            root,
            1,
            rotation=(rng.random(), rng.random(), angle),
        )
    cylinder("EMISSIVE_LAVA_CRATER", (0.03, 0.01, 0.705), 0.15, 0.025, mats.glow, root, 9, radius_top=0.18)
    cylinder("STONE_CALDERA_KEEP", (-0.08, 0.08, 0.84), 0.12, 0.35, mats.stone, root, 8, 0.075)
    tower_count = 5 if lod == 0 else 4 if lod == 1 else 3
    for index in range(tower_count):
        angle = index / tower_count * math.tau + 0.32
        x, y = math.cos(angle) * 0.43, math.sin(angle) * 0.43
        tower_height = 0.34 + (index % 3) * 0.09
        cylinder(f"STONE_FOUNDRY_TOWER_{index}", (x, y, 0.49 + tower_height * 0.25), 0.075, tower_height, mats.trim, root, 8, 0.045)
        cylinder(f"DARK_FOUNDRY_CROWN_{index}", (x, y, 0.68 + tower_height * 0.25), 0.095, 0.09, mats.dark, root, 8, 0.055)
        curve_path(
            f"STONE_CRATER_BRIDGE_{index}",
            [(x, y, 0.58), (x * 0.55, y * 0.55, 0.68), (0.03, 0.01, 0.75)],
            0.028,
            mats.stone,
            root,
        )
    lava_count = 5 if lod == 0 else 3 if lod == 1 else 2
    for index in range(lava_count):
        angle = index / lava_count * math.tau + 0.35
        curve_path(
            f"EMISSIVE_LAVA_CHANNEL_{index}",
            [
                (math.cos(angle) * 0.2, math.sin(angle) * 0.2, 0.68),
                (math.cos(angle) * 0.42, math.sin(angle) * 0.42, 0.28),
                (math.cos(angle) * 0.75, math.sin(angle) * 0.75, 0.06),
            ],
            0.019,
            mats.glow,
            root,
        )
    for index in range(3 if lod < 2 else 1):
        ico(f"FX_SMOKE_{index}", (-0.08 + index * 0.07, 0.08 - index * 0.03, 1.08 + index * 0.09), (0.08, 0.07, 0.11), mats.dark, root)


def build_toxic(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("STONE_TERRAIN_SOCKET", 0.9, 0.085, mats.dark, root, rng)
    cube("STONE_REFINERY_NAVE", (0, 0.06, 0.34), (0.5, 0.7, 0.54), mats.stone, root, bevel=0.035)
    crystal("DARK_REFINERY_APSE", (0, 0.29, 0.66), 0.21, 0.48, mats.dark, root, sides=7)
    for side in (-1, 1):
        cube(f"STONE_NAVE_BUTTRESS_{side}", (side * 0.32, 0.12, 0.36), (0.13, 0.42, 0.48), mats.stone, root, rotation=(0, side * 0.1, 0), bevel=0.018)
    for side in (-1, 1):
        cylinder(f"METAL_REACTOR_TANK_{side}", (side * 0.43, -0.08, 0.3), 0.15, 0.48, mats.trim, root, 12)
        cylinder(f"METAL_SMOKE_STACK_{side}", (side * 0.33, 0.25, 0.57), 0.055, 0.58, mats.dark, root, 8, 0.035)
        curve_path(
            f"METAL_FEED_PIPE_{side}",
            [(side * 0.43, -0.08, 0.42), (side * 0.26, -0.02, 0.48), (side * 0.18, 0.08, 0.31)],
            0.035,
            mats.trim,
            root,
        )
    if lod < 2:
        for index in range(4):
            angle = index / 4 * math.tau + math.pi / 4
            cube(
                f"METAL_COLLAPSED_GANTRY_{index}",
                (math.cos(angle) * 0.48, math.sin(angle) * 0.48, 0.2 + (index % 2) * 0.08),
                (0.42, 0.055, 0.055),
                mats.trim,
                root,
                rotation=(0.08 * index, 0.1, angle),
                bevel=0.008,
            )
    cylinder("EMISSIVE_TOXIC_RESERVOIR", (0, -0.42, 0.075), 0.25, 0.035, mats.glow, root, 16, radius_top=0.31)
    ico("FX_TOXIC_VAPOR", (0.07, -0.4, 0.23), (0.12, 0.09, 0.18), mats.glow, root)


def build_crystal_basin(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("STONE_TERRAIN_SOCKET", 0.88, 0.08, mats.dark, root, rng)
    cylinder("CRYSTAL_REFLECTIVE_BASIN", (0, -0.08, 0.085), 0.39, 0.028, mats.accent, root, 14, radius_top=0.47)
    cylinder("STONE_PALACE_TERRACE", (0, 0.11, 0.2), 0.34, 0.24, mats.stone, root, 9, 0.28, bevel=0.018)
    crystal("CRYSTAL_PALACE_KEEP", (0, 0.12, 0.58), 0.2, 0.72, mats.trim, root, sides=7)
    count = 9 if lod == 0 else 6 if lod == 1 else 4
    for index in range(count):
        angle = index / count * math.tau + rng.random() * 0.18
        radius = 0.075 + rng.random() * 0.055
        height = 0.3 + rng.random() * 0.4
        distance = 0.36 + rng.random() * 0.22
        name = f"FX_FLOAT_CRYSTAL_{index}" if index % 3 == 0 else f"CRYSTAL_SPIRE_{index}"
        crystal(name, (math.cos(angle) * distance, math.sin(angle) * distance, 0.12 + height * 0.5), radius, height, mats.accent, root, rotation=(0.08 * rng.random(), 0.1 * rng.random(), angle))
    for index in range(3 if lod < 2 else 1):
        angle = index / 3 * math.tau
        curve_path(
            f"CRYSTAL_PRISM_ARCH_{index}",
            [
                (math.cos(angle - 0.28) * 0.5, math.sin(angle - 0.28) * 0.5, 0.13),
                (math.cos(angle) * 0.42, math.sin(angle) * 0.42, 0.62),
                (math.cos(angle + 0.28) * 0.5, math.sin(angle + 0.28) * 0.5, 0.13),
            ],
            0.045,
            mats.trim,
            root,
        )
    crystal("FX_CORE", (0, 0.12, 0.91), 0.095, 0.32, mats.glow, root)


def build_void(root: bpy.types.Object, mats: MaterialSet, lod: int, rng: random.Random) -> None:
    irregular_socket("DARK_TERRAIN_SOCKET", 0.9, 0.08, mats.dark, root, rng)
    for side in (-1, 1):
        cube(
            f"STONE_SHATTERED_MONOLITH_{side}",
            (side * 0.34, 0.02, 0.52),
            (0.24, 0.28, 0.92),
            mats.stone,
            root,
            rotation=(0.04, side * 0.1, side * -0.18),
            bevel=0.045,
        )
        crystal(f"CRYSTAL_BROKEN_CROWN_{side}", (side * 0.34, 0.02, 1.01), 0.14, 0.34, mats.trim, root, rotation=(0.1, 0.1, side * 0.2))
        cube(f"DARK_MONOLITH_WING_{side}", (side * 0.58, 0.08, 0.31), (0.36, 0.16, 0.2), mats.dark, root, rotation=(0, side * 0.12, side * -0.3), bevel=0.025)
    curve_path(
        "STONE_VOID_GATE_ARCH",
        [(-0.34, 0.02, 0.78), (-0.08, 0.02, 1.13), (0.34, 0.02, 0.78)],
        0.065,
        mats.stone,
        root,
    )
    ico("FX_CORE", (0, 0.02, 0.61), (0.16, 0.13, 0.24), mats.glow, root, 2)
    debris_count = 8 if lod == 0 else 5 if lod == 1 else 3
    for index in range(debris_count):
        angle = index / debris_count * math.tau + rng.random() * 0.15
        distance = 0.42 + rng.random() * 0.18
        crystal(
            f"FX_FLOAT_DEBRIS_{index}",
            (math.cos(angle) * distance, math.sin(angle) * distance, 0.38 + rng.random() * 0.42),
            0.055,
            0.18 + rng.random() * 0.12,
            mats.trim,
            root,
            rotation=(rng.random(), rng.random(), rng.random()),
        )


HERO_BUILDERS = {
    "frozen-crown": build_frozen,
    "thunder-highlands": build_thunder,
    "whispering-desert": build_desert,
    "ancient-jungle": lambda root, mats, lod, rng: add_tree_structure(root, mats, lod, rng, False),
    "emerald-wilds": lambda root, mats, lod, rng: add_tree_structure(root, mats, lod, rng, True),
    "liquid-blu-metal-sea": build_magnetic,
    "molten-wastes": build_molten,
    "toxic-expanse": build_toxic,
    "crystal-basin": build_crystal_basin,
    "void-scar": build_void,
}


def descendants(root: bpy.types.Object) -> list[bpy.types.Object]:
    result = [root]
    for child in root.children:
        result.extend(descendants(child))
    return result


def export_selected(root: bpy.types.Object, filepath: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in descendants(root):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    filepath.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )


def create_regional_monument(
    biome_id: str,
    archetype: str,
    parent: bpy.types.Object,
    mats: MaterialSet,
    rng: random.Random,
) -> None:
    irregular_socket(f"STONE_{archetype}_SOCKET", 0.38, 0.035, mats.dark, parent, rng, 12)
    organic = biome_id in ("ancient-jungle", "emerald-wilds")
    industrial = biome_id in ("liquid-blu-metal-sea", "molten-wastes", "toxic-expanse")
    crystalline = biome_id in ("frozen-crown", "crystal-basin", "void-scar")
    if archetype == "GATE":
        for side in (-1, 1):
            if organic:
                curve_path(f"ORGANIC_GATE_ROOT_{side}", [(side * 0.27, 0, 0.04), (side * 0.2, 0, 0.38), (0, 0, 0.58)], 0.06, mats.organic, parent)
            else:
                cube(f"STONE_GATE_PYLON_{side}", (side * 0.24, 0, 0.25), (0.11, 0.16, 0.44), mats.stone, parent, rotation=(0, side * 0.08, side * -0.08))
        curve_path("TRIM_GATE_ARCH", [(-0.24, 0, 0.45), (0, 0, 0.64), (0.24, 0, 0.45)], 0.045, mats.trim, parent)
        crystal("EMISSIVE_GATE_SIGIL", (0, 0, 0.47), 0.055, 0.16, mats.glow, parent)
    elif archetype == "SHRINE":
        cylinder("STONE_SHRINE_DAIS", (0, 0, 0.11), 0.23, 0.14, mats.stone, parent, 10, radius_top=0.18)
        for index in range(3):
            angle = index / 3 * math.tau
            if industrial:
                cylinder(f"METAL_SHRINE_ARM_{index}", (math.cos(angle) * 0.18, math.sin(angle) * 0.18, 0.31), 0.035, 0.34, mats.trim, parent, 8, 0.02)
            else:
                crystal(f"CRYSTAL_SHRINE_SPIRE_{index}", (math.cos(angle) * 0.16, math.sin(angle) * 0.16, 0.3), 0.05, 0.32, mats.accent, parent)
        ico("EMISSIVE_SHRINE_CORE", (0, 0, 0.42), (0.08, 0.08, 0.1), mats.glow, parent)
    else:
        for index in range(5):
            angle = index / 5 * math.tau + rng.random() * 0.35
            distance = 0.12 + rng.random() * 0.17
            if crystalline:
                crystal(f"CRYSTAL_RUIN_{index}", (math.cos(angle) * distance, math.sin(angle) * distance, 0.16), 0.05 + rng.random() * 0.03, 0.24 + rng.random() * 0.15, mats.accent, parent, rotation=(0.1, 0.1, angle))
            elif organic:
                curve_path(f"ORGANIC_RUIN_ROOT_{index}", [(0, 0, 0.05), (math.cos(angle) * distance * 0.6, math.sin(angle) * distance * 0.6, 0.23), (math.cos(angle) * distance, math.sin(angle) * distance, 0.1)], 0.035, mats.organic, parent)
            else:
                cube(f"STONE_RUIN_SLAB_{index}", (math.cos(angle) * distance, math.sin(angle) * distance, 0.15), (0.08, 0.11, 0.27), mats.stone, parent, rotation=(0.2 * rng.random(), 0.2 * rng.random(), angle))
        cube("STONE_RUIN_ALTAR", (0, 0, 0.15), (0.2, 0.16, 0.18), mats.trim, parent, bevel=0.018)
        crystal("EMISSIVE_RUIN_RELIC", (0, 0, 0.34), 0.055, 0.19, mats.glow, parent)


def create_ambient_cluster(
    biome_id: str,
    root: bpy.types.Object,
    mats: MaterialSet,
    rng: random.Random,
) -> None:
    organic = biome_id in ("ancient-jungle", "emerald-wilds")
    industrial = biome_id in ("liquid-blu-metal-sea", "molten-wastes", "toxic-expanse")
    crystalline = biome_id in ("frozen-crown", "crystal-basin", "void-scar")
    for index in range(7):
        angle = rng.random() * math.tau
        distance = 0.08 + rng.random() * 0.32
        x, y = math.cos(angle) * distance, math.sin(angle) * distance
        if organic:
            curve_path(f"ORGANIC_PROP_{index}", [(x * 0.3, y * 0.3, 0), (x * 0.7, y * 0.7, 0.12), (x, y, 0.02)], 0.025 + rng.random() * 0.018, mats.organic, root)
        elif industrial:
            if index % 2:
                cylinder(f"METAL_PROP_{index}", (x, y, 0.12), 0.025 + rng.random() * 0.025, 0.2 + rng.random() * 0.15, mats.trim, root, 7, 0.018)
            else:
                curve_path(f"METAL_PIPE_PROP_{index}", [(x, y, 0.02), (x * 0.8, y * 0.8, 0.14), (x * 0.55, y * 0.55, 0.18)], 0.018, mats.trim, root)
        elif crystalline:
            crystal(f"CRYSTAL_PROP_{index}", (x, y, 0.1), 0.035 + rng.random() * 0.035, 0.18 + rng.random() * 0.2, mats.accent, root, rotation=(rng.random() * 0.2, rng.random() * 0.2, angle))
        else:
            ico(f"STONE_PROP_{index}", (x, y, 0.07), (0.08, 0.055, 0.1 + rng.random() * 0.06), mats.stone, root, 1, rotation=(rng.random(), rng.random(), rng.random()))


def stronghold_profile_parts(
    biome_id: str,
    variant: int,
    module: str,
    root: bpy.types.Object,
    mats: MaterialSet,
    rng: random.Random,
) -> None:
    organic = biome_id in ("ancient-jungle", "emerald-wilds")
    industrial = biome_id in ("liquid-blu-metal-sea", "molten-wastes", "toxic-expanse")
    crystalline = biome_id in ("frozen-crown", "crystal-basin", "void-scar")
    offset = (variant - 1) * 0.035
    if module == "BASE":
        irregular_socket("BASE_SOCKET", 0.38 + variant * 0.025, 0.035, mats.stone, root, rng, 10)
        count = 4 + variant
        for index in range(count):
            angle = index / count * math.tau + variant * 0.3
            distance = 0.22 + (index % 2) * 0.04
            if organic:
                curve_path(f"BASE_ROOT_{index}", [(0, 0, 0.05), (math.cos(angle) * distance * 0.55, math.sin(angle) * distance * 0.55, 0.16), (math.cos(angle) * distance, math.sin(angle) * distance, 0.03)], 0.04, mats.stone, root)
            elif crystalline:
                crystal(f"BASE_SHARD_{index}", (math.cos(angle) * distance, math.sin(angle) * distance, 0.15), 0.045, 0.25, mats.stone, root, rotation=(0.1, 0.1, angle))
            else:
                cube(f"BASE_WALL_{index}", (math.cos(angle) * distance, math.sin(angle) * distance, 0.12), (0.2, 0.065, 0.17), mats.stone, root, rotation=(0, 0, angle + math.pi / 2), bevel=0.01)
    elif module == "LIVE":
        if organic:
            cylinder("LIVE_TRUNK", (offset, 0, 0.25), 0.075, 0.45 + variant * 0.06, mats.stone, root, 8, 0.045)
            for index in range(3):
                angle = index / 3 * math.tau
                curve_path(f"LIVE_BRANCH_{index}", [(offset, 0, 0.32), (math.cos(angle) * 0.14, math.sin(angle) * 0.14, 0.5), (math.cos(angle) * 0.24, math.sin(angle) * 0.24, 0.45)], 0.035, mats.stone, root)
        elif industrial:
            cylinder("LIVE_REACTOR", (offset, 0, 0.24), 0.13, 0.42 + variant * 0.05, mats.stone, root, 10, 0.09)
            for side in (-1, 1):
                cylinder(f"LIVE_STACK_{side}", (side * 0.16, 0.02, 0.28), 0.035, 0.4, mats.stone, root, 7, 0.025)
        elif crystalline:
            crystal("LIVE_CENTRAL_SHARD", (offset, 0, 0.32), 0.13, 0.58 + variant * 0.06, mats.stone, root, rotation=(0.08, 0.06, variant * 0.2))
            for side in (-1, 1):
                crystal(f"LIVE_SIDE_SHARD_{side}", (side * 0.16, 0.04, 0.23), 0.065, 0.36, mats.stone, root, rotation=(0.1, 0.1, side * 0.22))
        else:
            cylinder("LIVE_KEEP", (offset, 0, 0.27), 0.14, 0.5 + variant * 0.05, mats.stone, root, 10, 0.1)
            for side in (-1, 1):
                cylinder(f"LIVE_TOWER_{side}", (side * 0.2, 0.06, 0.22), 0.07, 0.38, mats.stone, root, 8, 0.05)
    else:
        height = 0.38 + variant * 0.05
        if organic:
            crystal("APEX_CANOPY", (offset, 0, height), 0.12, 0.3, mats.stone, root)
        elif industrial:
            for side in (-1, 1):
                cylinder(f"APEX_MACHINE_PYLON_{side}", (offset + side * 0.12, 0, height), 0.035, 0.32, mats.stone, root, 7, 0.02)
            curve_path(
                "APEX_MACHINE_YOKE",
                [(offset - 0.12, 0, height + 0.1), (offset, 0, height + 0.24), (offset + 0.12, 0, height + 0.1)],
                0.025,
                mats.stone,
                root,
            )
            crystal("APEX_MACHINE_CORE", (offset, 0, height + 0.08), 0.075, 0.2, mats.stone, root)
        elif crystalline:
            for index in range(3):
                angle = index / 3 * math.tau + variant * 0.2
                crystal(
                    f"APEX_CRYSTAL_CROWN_{index}",
                    (offset + math.cos(angle) * 0.12, math.sin(angle) * 0.12, height),
                    0.045,
                    0.27,
                    mats.stone,
                    root,
                    rotation=(0.16, 0.12, angle),
                )
        else:
            crystal("APEX_BEACON", (offset, 0, height), 0.085, 0.3, mats.stone, root)


def join_mesh_descendants(root: bpy.types.Object, name: str) -> None:
    objects = [obj for obj in descendants(root) if obj.type in ("MESH", "CURVE")]
    for obj in objects:
        if obj.type == "CURVE":
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.convert(target="MESH")
            obj.select_set(False)
    objects = [obj for obj in descendants(root) if obj.type == "MESH"]
    if not objects:
        return
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    joined.parent = root
    joined.select_set(False)


def export_whole_scene(filepath: Path) -> None:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )


def generate_hero_assets(output_dir: Path, manifest: dict) -> None:
    for biome_index, biome_id in enumerate(BIOMES):
        for lod in range(3):
            clear_scene()
            rng = random.Random(90210 + biome_index * 101 + lod * 17)
            mats = make_materials(biome_id)
            root = empty(f"HERO_{biome_id.upper().replace('-', '_')}_LOD{lod}")
            HERO_BUILDERS[biome_id](root, mats, lod, rng)
            output = output_dir / "heroes" / f"{biome_id}-lod{lod}.glb"
            export_selected(root, output)
            manifest["heroes"].append({
                "biomeId": biome_id,
                "lod": lod,
                "file": output.relative_to(output_dir).as_posix(),
            })


def generate_regional_pack(output_dir: Path, manifest: dict) -> None:
    clear_scene()
    for biome_index, biome_id in enumerate(BIOMES):
        mats = make_materials(biome_id)
        for archetype_index, archetype in enumerate(("GATE", "SHRINE", "RUIN")):
            rng = random.Random(12000 + biome_index * 67 + archetype_index * 11)
            root = empty(f"REGION_{biome_id.upper().replace('-', '_')}_{archetype}")
            create_regional_monument(biome_id, archetype, root, mats, rng)
            manifest["regional"].append({"biomeId": biome_id, "archetype": archetype.lower(), "node": root.name})
    export_whole_scene(output_dir / "regional-monuments.glb")


def generate_ambient_pack(output_dir: Path, manifest: dict) -> None:
    clear_scene()
    for biome_index, biome_id in enumerate(BIOMES):
        mats = make_materials(biome_id)
        rng = random.Random(34000 + biome_index * 83)
        root = empty(f"PROP_{biome_id.upper().replace('-', '_')}")
        create_ambient_cluster(biome_id, root, mats, rng)
        manifest["ambient"].append({"biomeId": biome_id, "node": root.name, "instances": 6})
    export_whole_scene(output_dir / "ambient-clusters.glb")


def generate_stronghold_pack(output_dir: Path, manifest: dict) -> None:
    clear_scene()
    for biome_index, biome_id in enumerate(BIOMES):
        mats = make_materials(biome_id)
        for variant in range(3):
            for module_index, module in enumerate(("BASE", "LIVE", "APEX")):
                rng = random.Random(56000 + biome_index * 103 + variant * 17 + module_index * 5)
                root = empty(f"STRONGHOLD_{biome_id.upper().replace('-', '_')}_V{variant}_{module}")
                stronghold_profile_parts(biome_id, variant, module, root, mats, rng)
                join_mesh_descendants(root, f"{root.name}_MESH")
                manifest["strongholds"].append({
                    "biomeId": biome_id,
                    "variant": variant,
                    "module": module.lower(),
                    "node": root.name,
                })
    export_whole_scene(output_dir / "stronghold-kit.glb")


def parse_output_dir() -> Path:
    args = sys.argv
    if "--" in args:
        args = args[args.index("--") + 1:]
    if "--output-dir" not in args:
        raise SystemExit("Expected --output-dir <path>")
    value = args[args.index("--output-dir") + 1]
    return Path(os.path.abspath(value))


def main() -> None:
    output_dir = parse_output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "generator": "Blender 4.5 LTS",
        "heroes": [],
        "regional": [],
        "strongholds": [],
        "ambient": [],
    }
    generate_hero_assets(output_dir, manifest)
    generate_regional_pack(output_dir, manifest)
    generate_stronghold_pack(output_dir, manifest)
    generate_ambient_pack(output_dir, manifest)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"Generated {len(manifest['heroes'])} hero LOD assets, "
        f"{len(manifest['regional'])} regional monuments, "
        f"{len(manifest['strongholds'])} stronghold modules, and "
        f"{len(manifest['ambient'])} ambient clusters."
    )


if __name__ == "__main__":
    main()
