import Razorpay from 'razorpay';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@vac/shared';
export type CreateVerifiedOrderInput={amount:number;currency:'INR';quoteId:string;grantId:string;cartDigest:string;merchantId:string};
export type CreatedOrder={id:string;amount:number;currency:string;status?:string};
export interface PaymentRail{createOrder(input:CreateVerifiedOrderInput):Promise<CreatedOrder>}
export class RazorpayAdapter implements PaymentRail{
  private client:Razorpay|null=null;
  constructor(private readonly keyId=process.env.RAZORPAY_KEY_ID,private readonly keySecret=process.env.RAZORPAY_KEY_SECRET){if(keyId&&keySecret)this.client=new Razorpay({key_id:keyId,key_secret:keySecret})}
  async createOrder(input:CreateVerifiedOrderInput):Promise<CreatedOrder>{if(!this.client||!this.keyId||!this.keySecret)throw new DomainError('RAZORPAY_NOT_CONFIGURED','Razorpay Test Mode credentials are not configured');if(!this.keyId.startsWith('rzp_test_'))throw new Error('Only Razorpay Test Mode keys are allowed in this build');const order=await this.client.orders.create({amount:input.amount,currency:input.currency,receipt:input.grantId.slice(0,40),notes:{quote_id:input.quoteId,grant_id:input.grantId,cart_digest:input.cartDigest.slice(0,120),merchant_id:input.merchantId}});return{id:order.id,amount:Number(order.amount),currency:String(order.currency),status:order.status}}
  verifyCheckoutSignature(orderId:string,paymentId:string,signature:string):boolean{if(!this.keySecret)throw new DomainError('RAZORPAY_NOT_CONFIGURED','Razorpay secret is not configured');const expected=createHmac('sha256',this.keySecret).update(`${orderId}|${paymentId}`).digest('hex'),a=Buffer.from(expected,'utf8'),b=Buffer.from(signature,'utf8');return a.length===b.length&&timingSafeEqual(a,b)}
  publicKeyId(){return this.keyId}
}