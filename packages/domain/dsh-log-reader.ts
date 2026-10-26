import {zstdDecompressSync} from 'node:zlib';
// Frame-layout handling adapted from dsh session-persistence-jsonl/src/zstd.ts,
// commit 9fcc9f4d6ea6e02ab92ed12bfb2ca627b3363035 (MIT; assets/licenses).
function frameEnd(bytes:Buffer,start:number):number|null{
 let at=start;const available=(size:number)=>bytes.length-at>=size;
 if(!available(4))return null;if(bytes.readUInt32LE(at)!==0xFD2FB528)throw Error('invalid zstd frame magic');at+=4;
 if(!available(1))return null;const descriptor=bytes[at++];if(descriptor&0x18)throw Error('reserved zstd frame-header bit');
 const sizeFlag=descriptor>>>6,single=!!(descriptor&0x20),dict=descriptor&3,header=(single?0:1)+(dict===3?4:dict)+(sizeFlag?1<<sizeFlag:single?1:0);
 if(!available(header))return null;at+=header;
 while(true){if(!available(3))return null;const block=bytes.readUIntLE(at,3);at+=3;const type=(block>>>1)&3;if(type===3)throw Error('reserved zstd block type');const payload=type===1?1:block>>>3;if(!available(payload))return null;at+=payload;if(block&1)break;}
 if(descriptor&4){if(!available(4))return null;at+=4;}return at;
}
/** dsh appends independent zstd frames. Node's one-shot decoder consumes only the first frame. */
export function decodeDshLog(bytes:Buffer){
 const chunks:Buffer[]=[];let consumed=0,frames=0,error:string|null=null;
 while(consumed<bytes.length){try{
  const end=frameEnd(bytes,consumed);if(end===null){error='incomplete final zstd frame';break;}
  chunks.push(zstdDecompressSync(bytes.subarray(consumed,end),{maxOutputLength:64*1024*1024}));consumed=end;frames++;
 }catch(cause){error=cause instanceof Error?cause.message:'compressed frame unavailable';break;}}
 return {text:Buffer.concat(chunks).toString('utf8'),frames,consumed_bytes:consumed,trailing_bytes:bytes.length-consumed,status:error?'partial':'complete',error};
}
