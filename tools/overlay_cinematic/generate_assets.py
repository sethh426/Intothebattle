import bpy
import math
import os
import sys
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'overlay-cinematic', 'models')

HEROES = [
    ('solar-vanguard', 'prismatic', 'hammer'),
    ('prism-arcanist', 'prismatic', 'staff'),
    ('tempest-lancer', 'prismatic', 'spear'),
    ('verdant-oracle', 'solar', 'staff'),
    ('moonveil-huntress', 'solar', 'blades'),
    ('emberforged-colossus', 'solar', 'greatsword'),
]

PALETTES = {
    'prismatic': {
        'metal': (0.42, 0.5, 0.66, 1), 'cloth': (0.025, 0.055, 0.13, 1),
        'trim': (0.72, 0.82, 1.0, 1), 'energy': (0.3, 0.8, 1.0, 1),
    },
    'solar': {
        'metal': (0.82, 0.78, 0.64, 1), 'cloth': (0.06, 0.13, 0.28, 1),
        'trim': (1.0, 0.58, 0.13, 1), 'energy': (1.0, 0.34, 0.06, 1),
    },
}

def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.armatures, bpy.data.actions):
        for item in list(block):
            block.remove(item)

def material(name, color, metallic=.15, roughness=.45, emission=None, strength=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = emission
        bsdf.inputs['Emission Strength'].default_value = strength
    return mat

def primitive(kind, name, loc, scale, mat, parent=None, bone=None, segments=12):
    if kind == 'cube': bpy.ops.mesh.primitive_cube_add(location=loc)
    elif kind == 'sphere': bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2 if segments > 8 else 1, location=loc)
    elif kind == 'cylinder': bpy.ops.mesh.primitive_cylinder_add(vertices=segments, location=loc)
    elif kind == 'cone': bpy.ops.mesh.primitive_cone_add(vertices=segments, location=loc)
    elif kind == 'torus': bpy.ops.mesh.primitive_torus_add(major_segments=segments * 2, minor_segments=max(4, segments // 2), location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat: obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj

def create_rig():
    arm_data = bpy.data.armatures.new('HeroRig')
    arm = bpy.data.objects.new('HeroRig', arm_data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bones = {
        'root': ((0,0,0), (0,0,.35)), 'spine': ((0,0,.35), (0,0,1.8)),
        'head': ((0,0,1.8), (0,0,2.45)),
        'upper_arm.L': ((0,0,1.65), (-.7,0,1.55)), 'forearm.L': ((-.7,0,1.55), (-1.2,0,1.25)),
        'upper_arm.R': ((0,0,1.65), (.7,0,1.55)), 'forearm.R': ((.7,0,1.55), (1.2,0,1.25)),
        'weapon_socket.R': ((1.2,0,1.25), (1.55,0,1.0)),
        'effect_socket.L': ((-1.2,0,1.25), (-1.45,0,1.2)),
        'hit_socket': ((0,-.05,1.25), (0,-.05,1.5)), 'hud_anchor': ((0,0,2.45), (0,0,2.8)),
    }
    for name, (head, tail) in bones.items():
        b = arm_data.edit_bones.new(name); b.head=head; b.tail=tail
        if name != 'root': b.parent = arm_data.edit_bones['root'] if name not in ('spine','head') else arm_data.edit_bones['spine' if name=='head' else 'root']
    bpy.ops.object.mode_set(mode='POSE')
    for pb in arm.pose.bones: pb.rotation_mode='XYZ'
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm

def add_animation(arm, name, poses):
    action = bpy.data.actions.new(name)
    arm.animation_data_create(); arm.animation_data.action = action
    for frame, bone, rotation, location in poses:
        pb = arm.pose.bones.get(bone)
        if not pb: continue
        pb.rotation_euler = rotation
        pb.location = location
        pb.keyframe_insert('rotation_euler', frame=frame, group=bone)
        pb.keyframe_insert('location', frame=frame, group=bone)
    for fc in action.fcurves:
        for kp in fc.keyframe_points: kp.interpolation='BEZIER'
    track = arm.animation_data.nla_tracks.new(); track.name=name
    track.strips.new(name, int(action.frame_range[0]), action)
    arm.animation_data.action = None

def animate(arm):
    z=(0,0,0); r=(0,0,0)
    add_animation(arm,'idle',[(1,'spine',r,z),(18,'spine',(0.025,0,0),(0,0,.035)),(36,'spine',r,z)])
    add_animation(arm,'attack',[(1,'upper_arm.R',r,z),(9,'upper_arm.R',(0,-.45,-1.15),z),(18,'upper_arm.R',(0,.15,.5),z),(26,'upper_arm.R',r,z)])
    add_animation(arm,'hit',[(1,'spine',r,z),(6,'spine',(.16,0,.22),(0,.08,-.05)),(14,'spine',r,z)])
    add_animation(arm,'heal',[(1,'upper_arm.L',r,z),(12,'upper_arm.L',(0,-.35,.9),z),(28,'upper_arm.L',r,z)])
    add_animation(arm,'shield',[(1,'upper_arm.L',r,z),(10,'upper_arm.L',(-.25,0,-.9),z),(25,'upper_arm.L',r,z)])
    add_animation(arm,'KO',[(1,'root',r,z),(18,'root',(0,1.15,0),(0,.15,-.3)),(36,'root',(0,1.48,0),(0,.3,-.7))])
    add_animation(arm,'victory',[(1,'upper_arm.R',r,z),(12,'upper_arm.R',(0,0,-2.1),z),(32,'upper_arm.R',(0,0,-2.1),z)])

def build_hero(hero_id, faction, weapon, detail):
    p=PALETTES[faction]; seg={0:16,1:10,2:6}[detail]
    metal=material('WeatheredSilver',p['metal'],.82,.25)
    cloth=material('FactionCloth',p['cloth'],.05,.62)
    trim=material('CelestialTrim',p['trim'],.75,.2)
    glow=material('PrismaticEnergy',p['energy'],.15,.18,p['energy'],5)
    skin=material('Skin',(0.48,.3,.22,1),0,.7)
    arm=create_rig()
    primitive('cylinder','Torso',(0,0,1.25),(.44,.3,.72),metal,arm,'spine',seg)
    primitive('cone','Mantle',(0,.12,.85),(.68,.16,.82),cloth,arm,'spine',seg)
    primitive('sphere','Head',(0,0,2.06),(.28,.24,.34),skin,arm,'head',seg)
    primitive('cone','Crown',(0,0,2.43),(.3,.3,.36),trim,arm,'head',seg)
    for side,x in [('L',-.52),('R',.52)]:
        primitive('sphere',f'Pauldron.{side}',(x,0,1.66),(.35,.3,.24),trim,arm,f'upper_arm.{side}',seg)
        primitive('cylinder',f'Arm.{side}',(x*1.45,0,1.35),(.16,.16,.48),metal,arm,f'forearm.{side}',seg)
        primitive('cylinder',f'Leg.{side}',(x*.5,0,.35),(.2,.22,.62),metal,arm,'root',seg)
    if weapon in ('staff','spear'):
        primitive('cylinder','Weapon',(1.28,0,1.1),(.055,.055,1.2),trim,arm,'weapon_socket.R',seg)
        primitive('sphere','WeaponCore',(1.28,0,2.25),(.18,.18,.25),glow,arm,'weapon_socket.R',seg)
    elif weapon == 'hammer':
        primitive('cylinder','Weapon',(1.25,0,1.0),(.07,.07,.85),trim,arm,'weapon_socket.R',seg)
        primitive('cube','HammerHead',(1.25,0,1.85),(.38,.22,.2),glow,arm,'weapon_socket.R')
        primitive('cube','Shield',(-1.15,.05,1.25),(.45,.12,.68),metal,arm,'forearm.L')
    elif weapon == 'blades':
        for x,b in [(1.25,'weapon_socket.R'),(-1.25,'effect_socket.L')]: primitive('cone',f'Blade{x}',(x,0,1.1),(.1,.05,.65),glow,arm,b,seg)
    else:
        primitive('cube','Greatsword',(1.25,0,1.35),(.16,.06,1.15),glow,arm,'weapon_socket.R')
    for i in range(3 if detail < 2 else 1):
        shard=primitive('cone',f'FloatingShard.{i}',((i-1)*.5,.12,2.45+i*.1),(.08,.08,.3),glow,arm,'hud_anchor',seg)
        shard.rotation_euler[1]=i*.65
    animate(arm)

def build_portal(detail):
    p=PALETTES['prismatic']; seg={0:24,1:16,2:8}[detail]
    metal=material('BlackPearl',(0.035,.045,.08,1),.9,.22)
    silver=material('PortalSilver',(.5,.58,.72,1),.85,.2)
    glow=material('PortalEnergy',p['energy'],.1,.12,p['energy'],7)
    primitive('torus','PortalRing',(0,0,2.3),(2.2,.35,2.2),silver,segments=seg)
    core = primitive('cylinder','PortalCore',(0,.08,2.3),(1.72,1.72,.035),glow,segments=seg)
    core.rotation_euler[0] = math.pi / 2
    for i in range(8 if detail<2 else 4):
        a=math.tau*i/(8 if detail<2 else 4); primitive('cone',f'RuneSpire.{i}',(math.cos(a)*2.35,0,2.3+math.sin(a)*2.35),(.16,.16,.55),metal,segments=seg)

def build_creature(index, detail, boss=False):
    seg={0:14,1:9,2:6}[detail]
    shell=material('BlackPearlChitin',(.025,.03,.065,1),.75,.26)
    glow=material('RiftGlow',(.35,.55,1,1),.1,.18,(.35,.55,1,1),6)
    s=1.65 if boss else 1
    primitive('sphere','Body',(0,0,1.05*s),(.62*s,.38*s,.75*s),shell,segments=seg)
    primitive('sphere','Core',(0,-.34,1.12*s),(.22*s,.1*s,.28*s),glow,segments=seg)
    primitive('cone','Head',(0,-.05,1.9*s),(.38*s,.4*s,.55*s),shell,segments=seg)
    for side in (-1,1):
        for j in range(2 if not boss else 3):
            primitive('cone',f'Claw.{side}.{j}',(side*(.55+j*.2)*s,0,(.8-j*.2)*s),(.12*s,.12*s,.65*s),shell,segments=seg)
        primitive('cone',f'Horn.{side}',(side*.28*s,0,2.35*s),(.11*s,.11*s,.55*s),glow,segments=seg)

def export(path):
    os.makedirs(os.path.dirname(path),exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path,export_format='GLB',use_selection=False,export_animations=True,export_nla_strips=True,export_apply=True)

def main():
    for hero_id,faction,weapon in HEROES:
        for detail in range(3):
            reset(); build_hero(hero_id,faction,weapon,detail); export(os.path.join(OUT,f'{hero_id}-lod{detail}.glb'))
    for detail in range(3):
        reset(); build_portal(detail); export(os.path.join(OUT,f'prismatic-portal-lod{detail}.glb'))
        for i in range(3):
            reset(); build_creature(i,detail); export(os.path.join(OUT,f'rift-creature-{i+1}-lod{detail}.glb'))
        reset(); build_creature(0,detail,True); export(os.path.join(OUT,f'celestial-regent-lod{detail}.glb'))

if __name__ == '__main__': main()
