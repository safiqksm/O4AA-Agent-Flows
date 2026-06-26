// Static inventory + shipment data for the demo resource (the "protected API"
// behind the access token). No database — just representative records.

export const inventory = [
  { sku: 'PG-1001', name: 'Carbon Road Bike Frame', category: 'Frames', quantity: 42, reorderLevel: 15, location: 'Warehouse A-12', unitPrice: 899.0 },
  { sku: 'PG-1002', name: 'Hydraulic Disc Brake Set', category: 'Brakes', quantity: 8, reorderLevel: 20, location: 'Warehouse A-04', unitPrice: 149.95 },
  { sku: 'PG-1003', name: 'Tubeless Tire 700x28c', category: 'Tires', quantity: 120, reorderLevel: 50, location: 'Warehouse B-07', unitPrice: 54.5 },
  { sku: 'PG-1004', name: 'Carbon Wheelset 50mm', category: 'Wheels', quantity: 19, reorderLevel: 10, location: 'Warehouse A-21', unitPrice: 1249.0 },
  { sku: 'PG-1005', name: 'Electronic Shifting Groupset', category: 'Drivetrain', quantity: 5, reorderLevel: 8, location: 'Warehouse C-02', unitPrice: 2199.0 },
  { sku: 'PG-1006', name: 'Ergonomic Saddle', category: 'Components', quantity: 73, reorderLevel: 25, location: 'Warehouse B-15', unitPrice: 89.99 },
];

export const shipments = [
  { id: 'SHP-24087', date: '2026-06-21', carrier: 'FedEx', status: 'Delivered', destination: 'Austin, TX', items: 18, trackingNumber: '7789-2231-0098' },
  { id: 'SHP-24086', date: '2026-06-20', carrier: 'UPS', status: 'In Transit', destination: 'Denver, CO', items: 6, trackingNumber: '1Z-9988-7766-55' },
  { id: 'SHP-24085', date: '2026-06-19', carrier: 'DHL', status: 'Delivered', destination: 'Portland, OR', items: 31, trackingNumber: 'DHL-5521-9087' },
  { id: 'SHP-24084', date: '2026-06-18', carrier: 'FedEx', status: 'Delayed', destination: 'Chicago, IL', items: 12, trackingNumber: '7789-4410-1123' },
  { id: 'SHP-24083', date: '2026-06-17', carrier: 'USPS', status: 'Delivered', destination: 'Seattle, WA', items: 9, trackingNumber: 'USPS-3320-7741' },
];
