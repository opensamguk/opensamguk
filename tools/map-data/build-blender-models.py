"""Export INT-27 models with Blender 5.3: blender -b -P tools/map-data/build-blender-models.py -- <output-dir>."""
import bpy
import math
import sys
from pathlib import Path

SLOTS = {
    'stone': (.40, .42, .43), 'earth': (.48, .31, .17), 'wood': (.32, .20, .12),
    'tile': (.19, .21, .23), 'glazed-tile': (.79, .43, .12), 'roof': (.22, .24, .26),
    'plaster': (.78, .71, .58), 'cloth': (.67, .56, .39), 'field': (.39, .32, .19),
    'crop': (.29, .40, .16), 'water': (.17, .29, .32), 'flag': (.65, .24, .15),
    'rock': (.42, .39, .34), 'road': (.52, .45, .33),
}
KINDS = ('pass', 'port', 'camp', 'farm', 'market', 'watchtower', 'barracks', 'houses', 'granary', 'shrine', 'water-fort', 'nomad-camp')
BUDGETS = (25000, 3000, 400)

def slot(name):
    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
        material.diffuse_color = (*SLOTS[name], 1)
    return material

def finish(obj, material):
    obj.data.materials.append(slot(material))
    return obj

def box(material, x, z, bottom, width, depth, height):
    # Blender Y is north; glTF export converts it to negative Z.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -z, bottom + height / 2))
    ob = bpy.context.object
    ob.scale = (width, depth, height)
    return finish(ob, material)

def mesh(material, verts, faces, uvs):
    data = bpy.data.meshes.new(material)
    data.from_pydata([(x, -z, y) for x, y, z in verts], [], faces)
    data.update()
    layer = data.uv_layers.new(name='UVMap')
    for loop in data.loops:
        layer.data[loop.index].uv = uvs[loop.vertex_index]
    obj = bpy.data.objects.new(material, data)
    bpy.context.collection.objects.link(obj)
    return finish(obj, material)

def roof(material, x, z, y, w, d, h, lod, hip=.54):
    bands = (8, 4, 1)[lod]
    segments = (10, 3, 1)[lod]
    verts, faces, uv = [], [], []
    for side in range(4):
        start = len(verts)
        for row in range(bands + 1):
            t = row / bands
            a, b = w / 2 * (1 - (1 - hip) * t), d / 2 * (1 - t)
            corners = [(-a, -b), (a, -b), (a, b), (-a, b)]
            p, q = corners[side], corners[(side + 1) % 4]
            for col in range(segments + 1):
                u = col / segments
                xx, zz = [p[i] + (q[i] - p[i]) * u for i in range(2)]
                lift = .20 * (2*u-1)**4 * (1-t)**3 if lod < 2 else 0
                verts.append((x+xx, y+h*(.07 + .93*t**1.6 + lift), z+zz))
                uv.append((xx/w+.5, zz/d+.5))
        for row in range(bands):
            for col in range(segments):
                a = start + row*(segments + 1) + col
                b = a + segments + 1
                faces.append((a, b, a+1) if row == bands-1 and side % 2 else (a,b,b+1,a+1))
    mesh(material, verts, faces, uv)
    if lod < 2 and material != 'cloth':
        box(material,x,z,y+h-.006,w*hip,.013,.010)

def hall(x,z,y,w,d,h,lod,material='tile'):
    box('plaster',x,z,y,w,d,h)
    if lod == 0:
        for front in (-1,1):
            for col in (-.45,0,.45):
                box('wood',x+col*w,z+front*d/2,y,w*.045,d*.08,h)
            box('wood',x,z+front*d/2,y+h*.77,w*1.04,d*.075,h*.15)
        box('wood',x,z+d/2,y,w*.23,d*.085,h*.65)
    roof(material,x,z,y+h,w*1.17,d*1.23,h*.57,lod)

def flag(x,z,y,h):
    box('wood',x,z,y,.014,.014,h)
    box('flag',x+.055,z,y+h*.654,.11,.011,h*.32)

def wall(material,x,z,y,w,d,h,lod):
    box(material,x,z,y,w,d,h)
    if lod == 2:
        return
    across = w>d
    length = max(w,d)
    count=max(2,round(length/(.036 if lod==0 else .09)))
    step=length/count
    for i in range(count):
        offset=(i+.5)*step-length/2
        box(material,x+(offset if across else 0),z+(0 if across else offset),y+h,
            step*.58 if across else .023,.023 if across else step*.58,.018)
    if material=='earth' and lod==0:
        for row in (.23,.43,.64,.84):
            box(material,x,z,y+h*row,w+(0 if across else .004),d+(.004 if across else 0),.003)

def gate(material,z,y,h,lod,tower):
    depth=.13
    if lod == 2:
        for side in (-1,1):
            box(material,side*.104,z,y,.08,depth,h)
        box(material,0,z,y+h*.75,.139,depth,h*.25)
    else:
        segments=(18,8)[lod]
        for i in range(segments):
            x1=-.145 + .29*i/segments
            x2=-.145 + .29*(i+1)/segments
            def opening(x):
                return 0 if abs(x) >= .073 else h*(.44+.36*math.sqrt(1-(x/.073)**2))
            v=[(x1,y+opening(x1),z-depth/2),(x2,y+opening(x2),z-depth/2),(x2,y+h,z-depth/2),(x1,y+h,z-depth/2)]
            v += [(x,y,z+depth) for x,y,z in v]
            mesh(material,v,[(0,1,2,3),(7,6,5,4),(4,5,1,0),(3,2,6,7)],
                 [((x+.145)/.29,(yy-y)/h) for x,yy,_ in v])
    if tower:
        hall(0,z,y+h,.25,.155,.079,lod,'roof')
        if lod<2:
            hall(0,z,y+h+.114,.155,.105,.058,lod,'roof')

def city(level, strength, lod, capital):
    y=.028
    edge=(.60+.032*(level-1))/2
    material='earth' if level<=3 else 'stone'
    thickness=(.058,.075,.095)[strength]
    h=(.080,.125,.176)[strength]*(.72 if level<=3 else .86 if level<=5 else 1)
    box('earth',0,0,0,1,1,y)
    wall(material,0,-edge,y,edge*2+thickness,thickness,h,lod)
    for sign in (-1,1):
        wall(material,sign*edge,0,y,thickness,2*edge,h,lod)
        width=edge-.13
        wall(material,sign*(.13+width/2),edge,y,width,thickness,h,lod)
    gate(material,edge-.026,y,h,lod,level>=4)
    if level>=6 or level>=4 and strength==2:
        for x in (-edge,edge):
            for z in (-edge,edge):
                box('stone',x,z,y,.117,.117,h+.025)
                if lod<2:
                    hall(x,z,y+h+.025,.081,.081,.052,lod,'roof')
    keep=.16+level*.022
    box('stone',0,-.15,y,keep+.035,.188,.024)
    hall(0,-.15,y+.024,keep,.145,.10+level*.009,lod,'glazed-tile' if capital else 'roof')
    if level>=6 and lod<2:
        hall(0,-.15,y+.187+level*.010,keep*.54,.09,.059,lod,'glazed-tile' if capital else 'roof')
    yards=[(-.139,.024),(.139,.024),(-.135,.183),(.135,.183),(-.247,-.22),(.247,-.22),(-.245,-.07),(.245,-.07)]
    for x,z in yards[:min(level+1,3 if lod==2 else 8)]:
        hall(x,z,y,.087,.068,.052,lod)
    if level>=4 and lod<2:
        box('road',0,.124,y,.025,.35,.004)
        for z in (.118,.25):
            box('road',0,z,y,edge*1.62,.021,.005)
    if level>=4 and lod==0:
        inner=edge+.057
        outer=.494
        mid=(inner+outer)/2
        strip=outer-inner
        for sign in (-1,1):
            box('water',0,sign*mid,y,outer*2,strip,.006)
            box('water',sign*mid,0,y,strip,inner*2,.006)
        box('wood',0,mid,y+.006,.11,strip+.010,.015)

def watch(x,z,y,scale,lod):
    box('stone',x,z,y,.33*scale,.32*scale,.047*scale)
    for dx in (-.13,.13):
        for dz in (-.13,.13):
            box('wood',x+dx*scale,z+dz*scale,y,.045*scale,.045*scale,.35*scale)
    box('wood',x,z,y+.28*scale,.34*scale,.34*scale,.044*scale)
    roof('tile',x,z,y+.35*scale,.40*scale,.40*scale,.10*scale,lod)

def building(kind,lod):
    if kind=='pass':
        for side in (-1, 1):
            subdivisions = (3, 2, 1)[lod]
            peaks = ((.35, .02, .16, .29, .37),)
            if lod < 2:
                peaks += ((.39, -.13, .10, .21, .27), (.38, .22, .11, .17, .21))
            for index, (offset, north, width, depth, height) in enumerate(peaks):
                bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1)
                rock = bpy.context.object
                for vertex in rock.data.vertices:
                    x, y, z = vertex.co
                    elevation = (z + 1) / 2
                    ridge = math.sin(11 * x + 6 * y + 7 * z + index + side)
                    ledge = math.cos(17 * elevation + 2 * y + index)
                    taper = 1.10 - .58 * elevation + .10 * ridge + .07 * ledge
                    vertex.co = (
                        side * (offset + .026 * elevation) + .82 * width * x * taper,
                        north + .91 * depth * y * taper,
                        max(0, height * (1.16 * elevation - .16) + .023 * ridge * elevation),
                    )
                finish(rock, 'rock')
            wall('stone', side * .30, 0, 0, .295, .16, .166, lod)
        gate('stone',0,0,.166,lod,True)
    elif kind in ('camp','nomad-camp'):
        box('earth',0,0,0,.94,.89,.02)
        if kind=='camp':
            for x in (-.43,.43):
                box('wood',x,0,.02,.043,.85,.10)
            box('wood',0,-.42,.02,.86,.044,.10)
        for x,z in [(-.23,-.18),(.23,-.18),(-.23,.18),(.23,.18)][:2 if lod==2 else 4]:
            box('cloth',x,z,.02,.19,.18,.055)
            roof('cloth',x,z,.075,.22,.21,.10,lod)
        if lod<2:
            watch(.33,.31,.02,.42,lod)
        flag(-.075,-.02,.02,.32)
    elif kind in ('port','water-fort'):
        box('water',0,.12,0,.98,.68,.01)
        box('stone',0,-.31,0,.95,.32,.063)
        for x in (-.24,.24):
            box('wood',x,.12,.02,.115,.57,.042)
        hall(0,-.28,.063,.34,.21,.124,lod,'roof')
        box('wood',0,.24,.01,.10,.23,.045)
        flag(0,.24,.055,.20)
        if kind=='water-fort':
            watch(-.31,-.27,0,.47,lod)
            watch(.31,-.27,0,.47,lod)
    elif kind=='farm':
        for x in (-.23,.23):
            box('field',x,-.11,0,.41,.60,.024)
            for row in (-.135,-.045,.045,.135):
                box('crop',x+row,-.11,.024,.034,.54,.016)
            for z in (-.409,.189):
                box('earth',x,z,.024,.41,.014,.013)
        hall(.18,.33,0,.24,.17,.10,lod)
    elif kind=='market':
        box('earth',0,0,0,.93,.83,.02)
        for x in (-.27,0,.27):
            for dx in (-.071,.071):
                box('wood',x+dx,.13,.02,.021,.023,.13)
            box('wood',x,.13,.02,.16,.12,.055)
            roof('cloth',x,.095,.15,.221,.24,.053,lod,1)
        hall(0,-.26,.02,.29,.21,.12,lod)
    elif kind=='watchtower':
        watch(0,0,0,1,lod)
    elif kind=='barracks':
        box('earth',0,0,0,.91,.79,.027)
        hall(0,-.23,.027,.63,.19,.125,lod)
        for x in (-.26,.26):
            hall(x,.06,.027,.18,.28,.075,lod)
        flag(0,.30,.027,.24)
    elif kind=='houses':
        box('earth',0,0,0,.88,.73,.016)
        for x,z,w in [(-.23,-.13,.27),(.21,-.05,.30),(-.13,.23,.23)]:
            hall(x,z,.016,w,.17,.09,lod)
    elif kind=='granary':
        for x in (-.25,0,.25):
            for z in (-.16,.16):
                box('stone',x,z,0,.085,.085,.10)
        box('wood',0,0,.10,.64,.45,.044)
        hall(0,0,.144,.62,.43,.19,lod)
    elif kind=='shrine':
        box('stone',0,0,0,.77,.70,.05)
        box('stone',0,-.06,.05,.64,.49,.06)
        hall(0,-.09,.11,.48,.30,.162,lod,'roof')

def export(kind,lod,path,wall_strength=1,capital=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if kind.startswith('city-'):
        city(int(kind.split('-')[1]),wall_strength,lod,capital)
    else:
        building(kind,lod)
    bpy.context.view_layer.update()
    objects=list(bpy.context.scene.objects)
    tris=0
    for obj in objects:
        obj.data.calc_loop_triangles()
        assert obj.data.uv_layers, obj.name
        tris += len(obj.data.loop_triangles)
        for vertex in obj.data.vertices:
            x,y,z=obj.matrix_world @ vertex.co
            assert abs(x)<=.50001 and abs(y)<=.50001 and z>=-.00001,(kind,lod,x,y,z)
    assert 0<tris<=BUDGETS[lod],(kind,lod,tris)
    for material in SLOTS:
        group=[obj for obj in bpy.context.scene.objects if obj.data.materials[0].name==material]
        if not group:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in group:
            obj.select_set(True)
        bpy.context.view_layer.objects.active=group[0]
        if len(group)>1:
            bpy.ops.object.join()
        group[0].name=material
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB',export_yup=True,
                              export_texcoords=True,export_normals=True,export_materials='EXPORT')
    return tris

def main():
    import hashlib
    import json
    args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    out=Path(args[0])
    out.mkdir(parents=True,exist_ok=True)
    files=[]
    options=[(name,1,False) for name in KINDS]
    options += [(f'city-{level}',wall,False) for level in range(1,9) for wall in range(3)]
    options += [(f'city-{level}',wall,True) for level in range(1,9) for wall in range(3)]
    for kind,wall,capital in options:
        prefix=kind
        if kind.startswith('city-'):
            prefix += f'-wall-{wall}' + ('-capital' if capital else '')
        for lod in range(3):
            file=out/f'{prefix}-lod{lod}.glb'
            count=export(kind,lod,file,wall,capital)
            files.append({'file':file.name,'triangles':count,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
    source={'generator':'tools/map-data/build-blender-models.py','blender':bpy.app.version_string,'assets':files}
    (out/'sources.json').write_text(json.dumps(source,indent=2)+'\n',encoding='utf8')
    print(f'Exported {len(files)} GLB files')

if __name__=='__main__':
    main()
