import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { PetMovement } = createRequire(import.meta.url)('../desktop/movement.cjs')

function fixture(t) {
  let time=1000,cursor={x:300,y:300},position={x:200,y:200},destroyed=false,failMove=false
  const calls=[],problems=[]
  const integer=n=>Number.isInteger(n)&&n>=-2147483648&&n<=2147483647
  const window={isDestroyed:()=>destroyed,getPosition:()=>{assert(!destroyed);return[position.x,position.y]},getSize:()=>[270,250],setIgnoreMouseEvents(){},
    setPosition:(x,y)=>{assert(!destroyed);assert(integer(x)&&integer(y),'native window rejects non-integer or invalid coordinates');if(failMove){failMove=false;throw TypeError('conversion failure at index 1')};position={x,y};calls.push(position)}}
  const area={x:0,y:0,width:1920,height:1080}
  const screen={getCursorScreenPoint:()=>cursor,getPrimaryDisplay:()=>({workArea:area}),getDisplayNearestPoint:p=>{assert(integer(p.x)&&integer(p.y));return{workArea:p.x<0?{...area,x:-1920}:area}}}
  const mover=new PetMovement({window,screen,now:()=>time,report:e=>problems.push(e.message)})
  t.after(()=>mover.stop())
  return{mover,calls,problems,position:()=>position,cursor:p=>cursor=p,time:n=>time=n,advance:n=>time+=n,destroy:()=>destroyed=true,failMove:()=>failMove=true}
}
test('invalid throw coordinates and velocities stop motion before reaching native window APIs',t=>{
  const f=fixture(t)
  for(const patch of [{y:NaN},{vy:NaN},{vy:undefined},{x:Infinity},{vx:-Infinity}]){
    f.mover.flight={x:200,y:200,vx:900,vy:-300,...patch};f.mover.lastAt=1000
    assert.doesNotThrow(()=>f.mover.tick());assert.equal(f.mover.active,false);assert.equal(f.mover.timer,null)
  }
  assert.equal(f.calls.length,0);assert.equal(f.problems.length,5)
  assert.deepEqual(f.position(),{x:200,y:200})
})
test('release after a bad drag sample does not read a cleared drag or mistake it for a click',t=>{
  const f=fixture(t);f.mover.begin();f.cursor({x:310,y:NaN});f.advance(30)
  assert.deepEqual(f.mover.end(),{clicked:false,cancelled:true})
  assert.equal(f.mover.active,false);assert.equal(f.problems.length,1)
  f.cursor({x:300,y:300});f.mover.begin();f.advance(30)
  assert.equal(f.mover.end().clicked,true)
})
test('release snapshots explicitly copy x and y even if cursor properties are not enumerable',t=>{
  const f=fixture(t)
  const point=(x,y)=>Object.defineProperties({},{x:{value:x,enumerable:true},y:{value:y,enumerable:false}})
  f.cursor(point(300,300));f.mover.begin()
  for(let i=1;i<=4;i++){f.advance(25);f.cursor(point(300+i*70,300-i*30));f.mover.tick()}
  assert.equal(f.mover.end().dragged,true)
  assert(Number.isFinite(f.mover.flight?.vx));assert(Number.isFinite(f.mover.flight?.vy))
  f.advance(16);f.mover.tick();assert.equal(f.problems.length,0)
})
test('rapid repeated clicks, interrupted throws and multi-display drags only send valid integers',t=>{
  const f=fixture(t)
  for(let i=0;i<150;i++){
    f.mover.begin();f.advance(3);assert.equal(f.mover.end().clicked,true)
    f.cursor({x:500,y:400});f.mover.begin()
    for(let n=0;n<5;n++){f.advance(20);f.cursor({x:500-(n+1)*170,y:400-(n+1)*20});f.mover.tick()}
    assert.equal(f.mover.end().dragged,true)
    for(let n=0;n<6;n++){f.advance(16);f.mover.tick()}
  }
  assert.equal(f.problems.length,0);assert(f.calls.length>1000)
})
test('a native move failure in the real timer is contained and the next drag remains usable',async t=>{
  const f=fixture(t);f.mover.begin();f.cursor({x:500,y:400});f.advance(20);f.failMove()
  await new Promise(r=>setTimeout(r,45))
  assert.equal(f.mover.active,false);assert.equal(f.mover.timer,null);assert.equal(f.problems.length,1)
  f.mover.begin({reducedMotion:true});f.cursor({x:600,y:400});f.advance(40)
  assert.equal(f.mover.end().dragged,true);assert(f.calls.length>0)
})
test('missing step time uses a finite step, invalid time and destroyed windows stop safely',t=>{
  const f=fixture(t);f.mover.flight={x:200,y:200,vx:800,vy:-200}
  assert.doesNotThrow(()=>f.mover.tick());assert(f.calls.length>0)
  f.time(NaN);f.mover.tick();assert.equal(f.mover.active,false)
  f.time(1200);f.mover.begin();f.destroy();assert.doesNotThrow(()=>f.mover.tick());assert.equal(f.mover.active,false)
})
