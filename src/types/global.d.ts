// Global type declarations
declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

declare module 'serialport' {
  export class SerialPort {
    constructor(options: any);
    on(event: string, callback: (...args: any[]) => void): this;
    write(data: Buffer, callback?: (err?: Error) => void): void;
    open(callback?: (err?: Error) => void): void;
    close(callback?: (err?: Error) => void): void;
    isOpen: boolean;
    path: string;
    baudRate: number;
  }
}
