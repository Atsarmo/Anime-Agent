/** Small native bitmap: a white sparkle on the pet UI's blue background. */
export function createTrayImage(nativeImage){
  const size=32,bitmap=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const dx=x-15.5,dy=y-15.5,r=Math.hypot(dx,dy),i=(y*size+x)*4;
    if(r>15)continue;
    const star=Math.abs(dx)*Math.abs(dy)<9&&Math.abs(dx)+Math.abs(dy)<12;
    bitmap[i]=star?255:199;bitmap[i+1]=star?255:150;bitmap[i+2]=star?255:113;bitmap[i+3]=Math.round(Math.min(1,15-r)*255);
  }
  return nativeImage.createFromBitmap(bitmap,{width:size,height:size});
}
